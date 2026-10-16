// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTabAudioAvailability, requestTabAudio } from './tabAudio';

class Track extends EventTarget {
  readyState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
  constructor(public kind: string, public surface = 'browser') { super(); }
  getSettings() { return { displaySurface: this.surface }; }
}
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
}
const outputTrack = new Track('audio');
let context: FakeContext;
let worklet: FakeWorklet;
class FakeContext extends EventTarget {
  state = 'running';
  audioWorklet = { addModule: vi.fn(async () => {}) };
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = 'closed'; });
  source = { connect: vi.fn(), disconnect: vi.fn() };
  destination = { stream: new Stream([outputTrack]), disconnect: vi.fn() };
  createMediaStreamSource = vi.fn(() => this.source);
  createMediaStreamDestination = vi.fn(() => this.destination);
  constructor() { super(); context = this; }
}
class FakeWorklet {
  port = { onmessage: null as null | ((event: { data: unknown }) => void), postMessage: vi.fn(), close: vi.fn() };
  connect = vi.fn(); disconnect = vi.fn();
  constructor() { worklet = this; }
  emit(data: unknown) { this.port.onmessage?.({ data }); }
}
const getDisplayMedia = vi.fn();
const getUserMedia = vi.fn();
const probe = vi.fn(() => { throw new TypeError('not a track'); });
let audio: Track, video: Track;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  audio = new Track('audio'); video = new Track('video'); outputTrack.readyState = 'live';
  getDisplayMedia.mockResolvedValue(new Stream([audio, video]));
  probe.mockImplementation(() => { throw new TypeError('not a track'); });
  vi.stubGlobal('AudioContext', FakeContext); vi.stubGlobal('AudioWorkletNode', FakeWorklet); vi.stubGlobal('MediaStream', Stream);
  vi.stubGlobal('isSecureContext', true);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Windows NT 10.0 Chrome/155.0.0.0');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getDisplayMedia, getUserMedia } });
  vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockReturnValue({ webkitSpeechRecognition: class { start = probe; abort() {} } } as unknown as Window);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('tab audio capture boundary', () => {
  it('probes the overload only in a detached frame and never opens a microphone', () => {
    probe.mockImplementation(() => {
      expect(document.querySelector('iframe')).toBeNull();
      throw new TypeError('not a track');
    });
    expect(getTabAudioAvailability().supported).toBe(true);
    expect(getDisplayMedia).not.toHaveBeenCalled(); expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('fails closed when a browser ignores the track argument', async () => {
    probe.mockImplementation(() => undefined as never);
    expect(getTabAudioAvailability().supported).toBe(false);
    await expect(requestTabAudio()).rejects.toThrow(/Chrome/);
    expect(getDisplayMedia).not.toHaveBeenCalled(); expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('rejects mobile even when desktop APIs are present', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android Chrome/155.0.0.0');
    expect(getTabAudioAvailability().supported).toBe(false);
  });
  it('opens the picker synchronously, keeps source playback and connects only to the speech destination', async () => {
    const pending = requestTabAudio();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(getDisplayMedia.mock.calls[0][0]).toMatchObject({ audio: { suppressLocalAudioPlayback: false }, systemAudio: 'exclude', selfBrowserSurface: 'exclude' });
    const capture = await pending;
    expect(capture.track).toBe(outputTrack);
    expect(worklet.connect).toHaveBeenCalledWith(context.destination);
    expect(video.stop).not.toHaveBeenCalled(); expect(audio.stop).not.toHaveBeenCalled();
    capture.close(); expect(audio.stop).toHaveBeenCalledOnce(); expect(video.stop).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
  });
  it.each(['no-audio', 'window', 'ended'])('cleans up and rejects an unusable selection: %s', async reason => {
    if (reason === 'no-audio') getDisplayMedia.mockResolvedValue(new Stream([video]));
    if (reason === 'window') video.surface = 'window';
    if (reason === 'ended') audio.readyState = 'ended';
    await expect(requestTabAudio()).rejects.toThrow(/音訊|分頁/);
    expect(video.stop).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('handles cancellation without starting microphone capture', async () => {
    getDisplayMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(requestTabAudio()).rejects.toThrow(/取消|允許/);
    expect(context.close).toHaveBeenCalledOnce(); expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('cleans up a successful picker if loading the audio processor fails', async () => {
    vi.stubGlobal('AudioWorkletNode', class { constructor() { throw new Error('graph failed'); } });
    await expect(requestTabAudio()).rejects.toThrow();
    expect(video.stop).toHaveBeenCalledOnce(); expect(audio.stop).toHaveBeenCalledOnce(); expect(context.close).toHaveBeenCalledOnce();
    expect(outputTrack.stop).toHaveBeenCalledOnce(); expect(context.source.disconnect).toHaveBeenCalledOnce();
  });
  it('keeps capture live across recognition gates and reports actual queued duration', async () => {
    const capture = await requestTabAudio(), onBuffer = vi.fn(), onEnded = vi.fn();
    capture.setCallbacks({ onBuffer, onEnded }); capture.setRecognitionActive(true); capture.setRecognitionActive(false);
    expect(audio.stop).not.toHaveBeenCalled();
    expect(worklet.port.postMessage).toHaveBeenCalledWith({ type: 'gate', active: false });
    worklet.emit({ type: 'status', bufferedMs: 1250 }); expect(onBuffer).toHaveBeenLastCalledWith(1250);
    capture.close();
  });
  it('stops new input immediately but resolves finish only after a drained acknowledgement', async () => {
    const capture = await requestTabAudio(); let completed = false;
    const finish = capture.finish().then(result => { completed = result; return result; });
    expect(audio.stop).toHaveBeenCalledOnce(); expect(outputTrack.stop).not.toHaveBeenCalled();
    await Promise.resolve(); expect(completed).toBe(false);
    worklet.emit({ type: 'drained' }); expect(await finish).toBe(true);
    capture.close(); expect(outputTrack.stop).toHaveBeenCalledOnce();
  });
  it('reports overflow once, preserves pending data, and replays an early end to newly registered callbacks', async () => {
    const capture = await requestTabAudio(); worklet.emit({ type: 'overflow' });
    const onEnded = vi.fn(); capture.setCallbacks({ onBuffer: vi.fn(), onEnded });
    video.dispatchEvent(new Event('ended')); worklet.emit({ type: 'overflow' });
    expect(onEnded).toHaveBeenCalledOnce(); expect(onEnded.mock.calls[0][0]).toMatch(/緩衝/);
    expect(worklet.port.postMessage).not.toHaveBeenCalledWith({ type: 'close' });
    capture.close();
  });
  it('bounds drain time and settles a pending finish on close', async () => {
    const capture = await requestTabAudio(); const pending = capture.finish();
    await vi.advanceTimersByTimeAsync(32000); expect(await pending).toBe(false); capture.close();
    getDisplayMedia.mockResolvedValue(new Stream([new Track('audio'), new Track('video')]));
    const next = await requestTabAudio(); const stopped = next.finish(); next.close(); expect(await stopped).toBe(false);
  });
  it('settles a pending drain immediately if the audio context is suspended', async () => {
    const capture = await requestTabAudio(); let outcome: boolean | undefined;
    const pending = capture.finish().then(result => { outcome = result; });
    context.state = 'suspended'; context.dispatchEvent(new Event('statechange'));
    await Promise.resolve(); expect(outcome).toBe(false);
    await pending; capture.close();
  });
});
