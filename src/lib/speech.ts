import type { SpeechState } from '../types';

interface Callbacks {
  onInterim: (text: string) => void;
  onFinal: (id: string, text: string) => void;
  onState: (state: SpeechState) => void;
  onError: (message: string) => void;
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
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  start(): void;
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

export class SpeechController {
  private readonly callbacks: Callbacks;
  private readonly id = `speech-${Date.now().toString(36)}-${++controllerSequence}`;
  private recognition: Recognition | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private wantsListening = false;
  private generation = 0;
  private retries = 0;

  constructor(callbacks: Callbacks) { this.callbacks = callbacks; }

  static isSupported(): boolean { return recognitionConstructor() !== undefined; }

  start(): void {
    if (this.wantsListening) return;
    this.wantsListening = true;
    this.retries = 0;
    this.begin('requesting');
  }

  pause(): void { this.halt('paused'); }
  stop(): void { this.halt('stopped'); }

  private halt(state: SpeechState): void {
    // Clear intent and invalidate callbacks before abort(), which can emit onend synchronously.
    this.wantsListening = false;
    this.invalidate();
    this.callbacks.onInterim('');
    this.callbacks.onState(state);
  }

  private invalidate(): void {
    this.generation += 1;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const previous = this.recognition;
    this.recognition = null;
    if (previous) {
      previous.onstart = previous.onend = previous.onerror = previous.onresult = null;
      try { previous.abort(); } catch { /* An already-ended recognizer needs no further cleanup. */ }
    }
  }

  private fail(message: string): void {
    this.halt('error');
    this.callbacks.onError(message);
  }

  private retry(silence = false): void {
    this.invalidate();
    if (!this.wantsListening) return;
    // A quiet microphone is expected during an interview; only failures spend retries.
    const delay = silence ? 1_000 : RETRY_DELAYS[this.retries++];
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
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => { if (current()) this.callbacks.onState('listening'); };
      recognition.onend = () => { if (current()) this.retry(); };
      recognition.onerror = event => {
        if (!current()) return;
        const fatal = FATAL_ERRORS[event.error];
        if (fatal) this.fail(fatal);
        else this.retry(event.error === 'no-speech');
      };
      recognition.onresult = event => {
        if (!current() || !event.results) return;
        const start = Number.isInteger(event.resultIndex) && event.resultIndex >= 0 ? event.resultIndex : 0;
        const interim: string[] = [];
        for (let index = 0; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript;
          if (typeof transcript !== 'string') continue;
          const text = transcript.trim().replace(/\s+/g, ' ');
          if (!text) continue;
          if (result.isFinal) {
            if (index < start || seen.has(index)) continue;
            seen.add(index);
            this.retries = 0;
            this.callbacks.onFinal(`${this.id}:${generation}:${index}`, text);
            if (!current()) return;
          } else {
            interim.push(text);
          }
        }
        this.callbacks.onInterim(interim.join(' '));
      };
      this.callbacks.onState(state);
      if (current()) recognition.start();
    } catch {
      this.fail('無法啟動麥克風。請檢查瀏覽器權限與裝置，或改用手動輸入。');
    }
  }
}
