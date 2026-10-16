import type { SpeechState } from '../types';

interface Callbacks {
  onInterim: (text: string) => void;
  onFinal: (id: string, text: string) => void;
  onUnconfirmed?: (id: string, text: string) => void;
  onState: (state: SpeechState) => void;
  onError: (message: string) => void;
}

export interface RecognitionInput {
  track: MediaStreamTrack;
  setRecognitionActive: (active: boolean) => void;
}

interface RecognitionResult {
  isFinal: boolean;
  readonly [index: number]: { transcript: string } | undefined;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
  onend: (() => void) | null;
  onnomatch: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;
const RETRY_DELAYS = [500, 1_000, 2_000];
const FATAL_ERRORS: Record<string, string> = {
  'not-allowed': '麥克風權限遭拒。請在瀏覽器允許麥克風後，手動重新開始。',
  'service-not-allowed': '瀏覽器不允許語音辨識服務。請使用支援的瀏覽器或貼上文字。',
  'audio-capture': '無法取得麥克風音訊。請檢查裝置是否連接或被其他程式占用。',
  'language-not-supported': '此瀏覽器的語音辨識不支援英文。請改用手動輸入。',
  'bad-grammar': '瀏覽器無法啟動語音辨識。請改用手動輸入。',
};
let controllerSequence = 0;

function recognitionConstructor(): RecognitionConstructor | undefined {
  const browser = globalThis as typeof globalThis & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  if (typeof browser.SpeechRecognition === 'function') return browser.SpeechRecognition;
  if (typeof browser.webkitSpeechRecognition === 'function') return browser.webkitSpeechRecognition;
  return undefined;
}

function isAndroidBrowser(): boolean {
  const browserNavigator = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  return /Android/i.test(browserNavigator?.userAgentData?.platform || browserNavigator?.userAgent || '');
}

export class SpeechController {
  private readonly callbacks: Callbacks;
  private readonly id = `speech-${Date.now().toString(36)}-${++controllerSequence}`;
  private recognition: Recognition | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private wantsListening = false;
  private generation = 0;
  private retries = 0;
  private lastInterim = '';
  private finishing: {
    state: 'paused' | 'stopped';
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(callbacks: Callbacks, private readonly input?: RecognitionInput) { this.callbacks = callbacks; }

  static isSupported(): boolean { return recognitionConstructor() !== undefined; }

  start(): void {
    if (this.wantsListening) return;
    this.wantsListening = true;
    this.retries = 0;
    this.begin('requesting');
  }

  pause(): void { this.halt('paused'); }
  stop(): void { this.halt('stopped'); }

  finish(state: 'paused' | 'stopped'): Promise<void> {
    if (this.finishing) {
      if (state === 'stopped') this.finishing.state = state;
      return this.finishing.promise;
    }
    if (!this.recognition) { this.halt(state); return Promise.resolve(); }
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.finishing = { state, promise, resolve, timer: setTimeout(() => this.completeFinish(), 1_500) };
    this.input?.setRecognitionActive(false);
    // Keep this generation's result handlers until stop() yields its final result and end.
    try { this.recognition.stop(); } catch { this.completeFinish(); }
    return promise;
  }

  private flushUnconfirmed(): void {
    const text = this.lastInterim;
    this.lastInterim = '';
    if (text) this.callbacks.onUnconfirmed?.(`${this.id}:${this.generation}:unconfirmed`, text);
  }

  private completeFinish(): void {
    const finishing = this.finishing;
    if (!finishing) return;
    this.flushUnconfirmed();
    if (this.finishing === finishing) this.halt(finishing.state);
  }

  private halt(state: SpeechState): void {
    // Clear intent and invalidate callbacks before abort(), which can emit onend synchronously.
    this.wantsListening = false;
    this.invalidate();
    this.lastInterim = '';
    const finishing = this.finishing;
    this.finishing = null;
    if (finishing) clearTimeout(finishing.timer);
    this.callbacks.onInterim('');
    this.callbacks.onState(state);
    finishing?.resolve();
  }

  private invalidate(): void {
    this.input?.setRecognitionActive(false);
    this.generation += 1;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const previous = this.recognition;
    this.recognition = null;
    if (previous) {
      previous.onstart = previous.onaudiostart = previous.onaudioend = previous.onend = previous.onnomatch = previous.onerror = previous.onresult = null;
      try { previous.abort(); } catch { /* An already-ended recognizer needs no further cleanup. */ }
    }
  }

  private fail(message: string): void {
    this.halt('error');
    this.callbacks.onError(message);
  }

  private retry(reason: 'failure' | 'silence' | 'completed' = 'failure'): void {
    this.invalidate();
    if (!this.wantsListening) return;
    // Silence and completed utterances are expected; only failures spend retries.
    const delay = reason === 'silence' ? 1_000 : reason === 'completed' ? 500 : RETRY_DELAYS[this.retries++];
    if (delay === undefined) {
      this.fail('語音辨識多次中斷，已停止自動重試。請檢查網路與麥克風，再手動重新開始。');
      return;
    }
    this.callbacks.onInterim('');
    this.callbacks.onState('reconnecting');
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.wantsListening && this.generation === generation) this.begin('reconnecting');
    }, delay);
  }

  private begin(state: SpeechState): void {
    if (this.input && (this.input.track.kind !== 'audio' || this.input.track.readyState !== 'live')) {
      this.fail('分頁音訊無法使用或已結束。請重新選擇包含聲音的分頁。');
      return;
    }
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      this.fail('此瀏覽器不支援語音辨識。請改用桌面 Chrome，或貼上英文文字。');
      return;
    }
    try {
      const recognition = new Constructor();
      this.recognition = recognition;
      const generation = ++this.generation;
      const seen = new Set<number>();
      const current = () => this.wantsListening && this.generation === generation && this.recognition === recognition;
      this.lastInterim = '';
      recognition.lang = 'en-US';
      // Android continuous mode can mark partial phrases final; our end handler resumes listening.
      recognition.continuous = !!this.input || !isAndroidBrowser();
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => { if (current() && !this.finishing) this.callbacks.onState('listening'); };
      recognition.onaudiostart = () => { if (current() && !this.finishing) this.input?.setRecognitionActive(true); };
      recognition.onaudioend = () => { if (current()) this.input?.setRecognitionActive(false); };
      recognition.onend = () => {
        if (!current()) return;
        this.input?.setRecognitionActive(false);
        if (this.finishing) { this.completeFinish(); return; }
        this.flushUnconfirmed();
        if (!current()) return;
        this.retry(!recognition.continuous && seen.size > 0 ? 'completed' : 'failure');
      };
      // Android can end an unmatched utterance without an error; wait without spending failure retries.
      recognition.onnomatch = () => {
        if (!current()) return;
        if (this.finishing) { this.completeFinish(); return; }
        this.flushUnconfirmed();
        if (!current()) return;
        this.retry('silence');
      };
      recognition.onerror = event => {
        if (!current()) return;
        this.input?.setRecognitionActive(false);
        if (this.finishing) { this.completeFinish(); return; }
        this.flushUnconfirmed();
        if (!current()) return;
        const fatal = FATAL_ERRORS[event.error];
        if (fatal) this.fail(fatal);
        else this.retry(event.error === 'no-speech' ? 'silence' : 'failure');
      };
      recognition.onresult = event => {
        if (!current() || !event.results) return;
        const start = Number.isInteger(event.resultIndex) && event.resultIndex >= 0 ? event.resultIndex : 0;
        const interim: string[] = [];
        const finals: { index: number; text: string }[] = [];
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript;
          if (typeof transcript !== 'string') continue;
          const text = transcript.trim().replace(/\s+/g, ' ');
          if (!text) continue;
          if (result.isFinal) {
            if (index < start || seen.has(index)) continue;
            finals.push({ index, text });
          } else {
            interim.push(text);
          }
        }
        // Update the tail before callbacks: callers can synchronously finish inside onFinal.
        this.lastInterim = interim.join(' ');
        for (const { index, text } of finals) {
          seen.add(index);
          this.retries = 0;
          this.callbacks.onFinal(`${this.id}:${generation}:${index}`, text);
          if (!current()) return;
        }
        this.callbacks.onInterim(this.lastInterim);
      };
      this.callbacks.onState(state);
      if (current() && !this.finishing) {
        if (this.input) recognition.start(this.input.track);
        else recognition.start();
      }
    } catch {
      this.fail(this.input ? '無法啟動分頁音訊辨識。請重新選擇分頁，或改用手動輸入。' : '無法啟動麥克風。請檢查瀏覽器權限與裝置，或改用手動輸入。');
    }
  }
}
