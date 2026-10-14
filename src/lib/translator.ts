type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
interface LocalTranslator {
  translate: (text: string) => Promise<string>;
  destroy: () => void;
}
interface DownloadMonitor {
  addEventListener: (name: 'downloadprogress', handler: (event: { loaded: number }) => void) => void;
}
interface TranslatorApi {
  availability: (options: { sourceLanguage: string; targetLanguage: string }) => Promise<string>;
  create: (options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (monitor: DownloadMonitor) => void;
  }) => Promise<LocalTranslator>;
}
const LANGUAGE_PAIR = { sourceLanguage: 'en', targetLanguage: 'zh-Hant' };

function translatorApi(): TranslatorApi | undefined {
  const api = (globalThis as typeof globalThis & { Translator?: TranslatorApi }).Translator;
  return api && typeof api.availability === 'function' && typeof api.create === 'function' ? api : undefined;
}

export async function getTranslationAvailability(): Promise<Availability> {
  const api = translatorApi();
  if (!api) return 'unavailable';
  try {
    const availability = await api.availability({ ...LANGUAGE_PAIR });
    return availability === 'available' || availability === 'downloadable' || availability === 'downloading'
      ? availability : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** Call from an explicit user action so Chrome can authorize a language-pack download. */
export async function createLocalTranslator(onProgress?: (fraction: number) => void): Promise<LocalTranslator> {
  const api = translatorApi();
  const availability = await getTranslationAvailability();
  if (!api || availability === 'unavailable') {
    throw new Error('此瀏覽器無法使用英文到繁體中文的本機翻譯。請使用支援的桌面 Chrome，或手動選擇其他翻譯模式。');
  }
  let native: LocalTranslator;
  let preparing = true;
  if (availability !== 'available') onProgress?.(0);
  try {
    native = await api.create({
      ...LANGUAGE_PAIR,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => {
          if (preparing && Number.isFinite(event.loaded)) {
            onProgress?.(Math.max(0, Math.min(1, event.loaded)));
          }
        });
      },
    });
  } catch {
    throw new Error('本機翻譯準備失敗。請檢查語言包下載、網路與瀏覽器設定，然後重試。');
  } finally {
    preparing = false;
  }
  onProgress?.(1);
  let destroyed = false;
  return {
    async translate(text) {
      if (destroyed) throw new Error('本機翻譯已結束。');
      if (typeof text !== 'string') throw new TypeError('翻譯內容必須是文字。');
      if (!text.trim()) return '';
      let translated: string;
      try {
        translated = await native.translate(text);
      } catch {
        throw new Error('這段本機翻譯失敗。英文內容已保留，請稍後重試。');
      }
      if (destroyed) throw new Error('本機翻譯已結束。');
      if (typeof translated !== 'string' || !translated.trim()) throw new Error('本機翻譯沒有傳回文字，請重試。');
      return translated.trim();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      native.destroy();
    },
  };
}
