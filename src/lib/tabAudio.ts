import type { RecognitionInput } from './speech';
import processorUrl from './tabAudio.worklet.ts?worker&url';

export interface TabAudioCapture extends RecognitionInput {
  setCallbacks(callbacks: { onBuffer(ms: number): void; onEnded(message: string): void }): void;
  finish(): Promise<boolean>;
  close(): void;
}

const UNSUPPORTED = '會議分頁音訊需使用新版電腦 Chrome（135 以上）；這台裝置可使用麥克風。';
type ProbeRecognition = { start(input: unknown): void; abort(): void };
type ProbeWindow = Window & { SpeechRecognition?: new () => ProbeRecognition; webkitSpeechRecognition?: new () => ProbeRecognition };

export function getTabAudioAvailability(): { supported: boolean; reason: string } {
  const ua = globalThis.navigator?.userAgent || '';
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getDisplayMedia || typeof AudioContext !== 'function' || typeof AudioWorkletNode !== 'function' || /Android|iPhone|iPad|Mobile/i.test(ua) || !/Chrome\/(\d+)/.test(ua) || Number(ua.match(/Chrome\/(\d+)/)?.[1]) < 135 || !globalThis.document?.body) {
    return { supported: false, reason: UNSUPPORTED };
  }
  // Probe argument validation in a detached, microphone-denied document. Old engines
  // may ignore start(track); probing in the main window could open its microphone.
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.allow = "microphone 'none'";
  let recognition: ProbeRecognition | undefined;
  try {
    document.body.appendChild(frame);
    const scope = frame.contentWindow as ProbeWindow | null;
    const Constructor = scope?.SpeechRecognition || scope?.webkitSpeechRecognition;
    if (!Constructor) return { supported: false, reason: UNSUPPORTED };
    recognition = new Constructor();
    frame.remove();
    try { recognition.start(0); } catch (error) {
      return { supported: (error as { name?: string })?.name === 'TypeError', reason: UNSUPPORTED };
    }
    return { supported: false, reason: UNSUPPORTED };
  } catch { return { supported: false, reason: UNSUPPORTED }; }
  finally { frame.remove(); try { recognition?.abort(); } catch { /* A detached probe owns no input. */ } }
}

function stopTracks(stream: MediaStream) { stream.getTracks().forEach(track => { if (track.readyState !== 'ended') track.stop(); }); }

class BufferedTabAudio implements TabAudioCapture {
  readonly track: MediaStreamTrack;
  private callbacks?: Parameters<TabAudioCapture['setCallbacks']>[0];
  private bufferedMs = 0;
  private endedMessage = '';
  private inputStopped = false;
  private closed = false;
  private drained = false;
  private processorFailed = false;
  private finishPromise?: Promise<boolean>;
  private settleFinish?: (drained: boolean) => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private context: AudioContext, private stream: MediaStream, private source: MediaStreamAudioSourceNode, private processor: AudioWorkletNode, private destination: MediaStreamAudioDestinationNode) {
    this.track = destination.stream.getAudioTracks()[0];
    stream.getTracks().forEach(track => track.addEventListener('ended', this.onTrackEnded));
    context.addEventListener('statechange', this.onContextState);
    processor.addEventListener?.('processorerror', this.onProcessorError);
    processor.port.onmessage = ({ data }) => {
      if (this.closed) return;
      if (data.type === 'status' && Number.isFinite(data.bufferedMs)) {
        this.bufferedMs = Math.max(0, data.bufferedMs);
        this.callbacks?.onBuffer(this.bufferedMs);
      }
      if (data.type === 'overflow') this.end('音訊緩衝已達 30 秒，收音已暫停；超出部分可能未被保留，請確認對方最後一句。');
      if (data.type === 'drained') { this.drained = true; this.resolveFinish(true); }
    };
  }
  setCallbacks(callbacks: Parameters<TabAudioCapture['setCallbacks']>[0]) {
    if (this.closed) return;
    this.callbacks = callbacks;
    callbacks.onBuffer(this.bufferedMs);
    if (this.endedMessage) callbacks.onEnded(this.endedMessage);
  }
  setRecognitionActive(active: boolean) { if (!this.closed) this.processor.port.postMessage({ type: 'gate', active }); }
  private onTrackEnded = () => { if (!this.inputStopped) this.end('分頁音訊分享已停止，正在保留最後一句。可重新選擇分頁繼續。'); };
  private onContextState = () => {
    if (!this.closed && this.context.state !== 'running') {
      this.end('瀏覽器暫停了音訊處理，部分聲音可能未處理；請重新選擇分頁。');
      this.resolveFinish(false);
    }
  };
  private onProcessorError = () => { this.processorFailed = true; this.end('分頁音訊處理中斷，部分聲音可能未處理；請重新選擇分頁。'); this.resolveFinish(false); };
  private end(message: string) {
    if (this.closed || this.endedMessage) return;
    this.endedMessage = message;
    this.stopInput();
    this.callbacks?.onEnded(message);
  }
  private stopInput() {
    if (this.inputStopped) return;
    this.inputStopped = true;
    stopTracks(this.stream);
  }
  finish(): Promise<boolean> {
    if (this.finishPromise) return this.finishPromise;
    if (this.closed) return Promise.resolve(false);
    this.stopInput();
    this.finishPromise = new Promise(resolve => { this.settleFinish = resolve; });
    this.timer = setTimeout(() => this.resolveFinish(false), 32_000);
    this.processor.port.postMessage({ type: 'finish' });
    if (this.context.state !== 'running' || this.processorFailed) this.resolveFinish(false);
    else if (this.drained) this.resolveFinish(true);
    return this.finishPromise;
  }
  private resolveFinish(drained: boolean) {
    if (!this.settleFinish) return;
    clearTimeout(this.timer);
    const resolve = this.settleFinish; this.settleFinish = undefined;
    resolve(drained);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopInput();
    this.resolveFinish(false);
    this.stream.getTracks().forEach(track => track.removeEventListener('ended', this.onTrackEnded));
    this.context.removeEventListener('statechange', this.onContextState);
    this.processor.removeEventListener?.('processorerror', this.onProcessorError);
    this.callbacks = undefined;
    this.processor.port.onmessage = null;
    this.processor.port.postMessage({ type: 'close' });
    this.processor.port.close();
    this.source.disconnect(); this.processor.disconnect(); this.destination.disconnect();
    stopTracks(this.destination.stream);
    void this.context.close().catch(() => {});
  }
}

export async function requestTabAudio(): Promise<TabAudioCapture> {
  const availability = getTabAudioAvailability();
  if (!availability.supported) throw new Error(availability.reason);
  // Do not await anything before opening the native picker: it requires this click's activation.
  const selection = navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    selfBrowserSurface: 'exclude', systemAudio: 'exclude', surfaceSwitching: 'exclude',
  } as DisplayMediaStreamOptions);
  let context: AudioContext | undefined, stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined, destination: MediaStreamAudioDestinationNode | undefined, processor: AudioWorkletNode | undefined;
  try {
    const preparation = (async () => {
      context = new AudioContext();
      await Promise.all([context.resume(), context.audioWorklet.addModule(processorUrl)]);
    })();
    // Observe both outcomes so cancelled/failed setup never leaks a late-selected stream.
    const [selected, prepared] = await Promise.allSettled([selection, preparation]);
    if (selected.status === 'fulfilled') stream = selected.value;
    else throw selected.reason;
    if (prepared.status === 'rejected') throw prepared.reason;
    const video = stream.getVideoTracks()[0], audio = stream.getAudioTracks()[0];
    if (!video || video.readyState !== 'live' || video.getSettings().displaySurface !== 'browser') throw new Error('請選擇 Chrome 分頁，再分享分頁音訊。');
    if (!audio || audio.readyState !== 'live') throw new Error('尚未分享分頁音訊。請重新選擇，並勾選「分享分頁音訊」。');
    if (!context || context.state !== 'running') throw new Error('分頁音訊尚未啟動，請重新點選開始並允許分享。');
    source = context.createMediaStreamSource(new MediaStream([audio]));
    destination = context.createMediaStreamDestination();
    processor = new AudioWorkletNode(context, 'aoa-tab-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    source.connect(processor); processor.connect(destination);
    return new BufferedTabAudio(context, stream, source, processor, destination);
  } catch (error) {
    if (stream) stopTracks(stream);
    source?.disconnect(); processor?.disconnect(); destination?.disconnect();
    if (processor) { processor.port.postMessage({ type: 'close' }); processor.port.close(); }
    if (destination) stopTracks(destination.stream);
    if (context) await context.close().catch(() => {});
    const name = (error as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') throw new Error('已取消或未允許分頁分享，尚未開始收音。');
    if (error instanceof Error && /分頁|音訊/.test(error.message)) throw error;
    throw new Error('無法準備分頁音訊，請使用新版電腦 Chrome，重新選擇會議分頁。');
  }
}
