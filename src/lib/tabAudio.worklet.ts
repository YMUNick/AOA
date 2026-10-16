import { PcmBuffer } from './pcmBuffer';

declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class TabAudioProcessor extends AudioWorkletProcessor {
  private readonly queue = new PcmBuffer(Math.ceil(sampleRate * 30));
  private mono = new Float32Array(128);
  private accepting = true;
  private active = false;
  private closed = false;
  private frames = 0;
  private drained = false;
  private tailFrames = 0;
  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'gate') this.active = data.active === true;
      if (data.type === 'finish') this.accepting = false;
      if (data.type === 'close') { this.closed = true; this.queue.clear(); this.mono.fill(0); }
      this.report();
    };
  }
  private report() {
    this.port.postMessage({ type: 'status', bufferedMs: this.queue.available / sampleRate * 1000 });
    if (!this.accepting && !this.queue.available && this.tailFrames >= sampleRate / 4 && !this.drained) {
      this.drained = true;
      this.port.postMessage({ type: 'drained' });
    }
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return !this.closed;
    output.fill(0);
    if (this.closed) return false;
    const pending = this.queue.available;
    // Free the quantum being delivered before enqueueing its replacement, including
    // when recognition resumes at exactly the capacity boundary.
    const alreadyRead = this.active && pending >= output.length;
    if (alreadyRead) this.queue.read(output);
    const channels = inputs[0];
    // No level threshold: retain every nonzero sample, including very quiet speech.
    // Elide only exact digital silence while disconnected so quiet retries do not
    // gradually fill the bounded queue. This intentionally shortens those pauses.
    const silentGap = !this.active && channels?.every(channel => channel.every(value => value === 0));
    if (this.accepting && channels?.length && !silentGap) {
      const length = channels[0].length;
      if (this.mono.length !== length) this.mono = new Float32Array(length);
      this.mono.fill(0);
      for (const channel of channels) for (let i = 0; i < length; i++) this.mono[i] += channel[i] / channels.length;
      if (!this.queue.push(this.mono)) {
        this.accepting = false;
        this.port.postMessage({ type: 'overflow' });
      }
    }
    if (this.active) {
      if (!alreadyRead) this.queue.read(output);
      // Let the destination deliver the last render block before native stop().
      if (!this.accepting && pending === 0) this.tailFrames += output.length;
      else this.tailFrames = 0;
    }
    this.frames += output.length;
    if (this.frames >= sampleRate / 10 || (!this.accepting && !this.queue.available && !this.drained)) {
      this.frames = 0;
      this.report();
    }
    return true;
  }
}
registerProcessor('aoa-tab-audio', TabAudioProcessor);
