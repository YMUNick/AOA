import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalTranslator, getTranslationAvailability } from './translator';

afterEach(() => { vi.unstubAllGlobals(); });

describe('local Translator availability', () => {
  it('reports unsupported browsers without initiating a download or network request', async () => {
    vi.stubGlobal('Translator', undefined);
    const network = vi.fn(() => { throw new Error('Unexpected cloud request'); });
    vi.stubGlobal('fetch', network);
    expect(await getTranslationAvailability()).toBe('unavailable');
    await expect(createLocalTranslator()).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['available', 'downloadable', 'downloading', 'unavailable'] as const)('checks the exact Traditional Chinese pair: %s', async availability => {
    const check = vi.fn(async () => availability);
    vi.stubGlobal('Translator', { availability: check, create: vi.fn() });
    expect(await getTranslationAvailability()).toBe(availability);
    expect(check).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'zh-Hant' });
  });

  it('turns a rejected capability check into unavailable', async () => {
    vi.stubGlobal('Translator', { availability: async () => { throw new Error('Blocked by policy'); }, create: vi.fn() });
    expect(await getTranslationAvailability()).toBe('unavailable');
  });

  it('does not accept unrecognized capability values', async () => {
    vi.stubGlobal('Translator', { availability: async () => 'future-value', create: vi.fn() });
    expect(await getTranslationAvailability()).toBe('unavailable');
  });
});

describe('local Translator lifecycle', () => {
  it('downloads the requested pair, reports fractional progress, and translates locally', async () => {
    const progress: number[] = [];
    const translate = vi.fn(async () => '請介紹你自己。');
    const create = vi.fn(async (options: {
      sourceLanguage: string; targetLanguage: string;
      monitor: (monitor: { addEventListener: (event: string, handler: (event: { loaded: number }) => void) => void }) => void;
    }) => {
      options.monitor({ addEventListener: (event, handler) => {
        expect(event).toBe('downloadprogress');
        handler({ loaded: 0.5 });
      } });
      return { translate, destroy: vi.fn() };
    });
    vi.stubGlobal('Translator', { availability: async () => 'downloadable', create });
    const local = await createLocalTranslator(value => progress.push(value));
    expect(create.mock.calls[0][0]).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'zh-Hant' });
    expect(progress).toContain(0.5);
    expect(progress.at(-1)).toBe(1);
    expect(await local.translate('Tell me about yourself.')).toBe('請介紹你自己。');
    expect(translate).toHaveBeenCalledWith('Tell me about yourself.');
    local.destroy();
  });

  it('rejects download failures without reporting readiness or falling back to cloud', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('Translator', { availability: async () => 'downloadable', create: async () => { throw new Error('Download failed'); } });
    const progress: number[] = [];
    await expect(createLocalTranslator(value => progress.push(value))).rejects.toThrow();
    expect(progress).not.toContain(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('does not attempt creation for an unsupported language pair', async () => {
    const create = vi.fn();
    vi.stubGlobal('Translator', { availability: async () => 'unavailable', create });
    await expect(createLocalTranslator()).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('destroys its native resource once and prevents later translations', async () => {
    const native = { translate: vi.fn(async () => '你好'), destroy: vi.fn() };
    vi.stubGlobal('Translator', { availability: async () => 'available', create: async () => native });
    const local = await createLocalTranslator();
    expect(await local.translate('   ')).toBe('');
    expect(native.translate).not.toHaveBeenCalled();
    local.destroy();
    local.destroy();
    await expect(local.translate('hello')).rejects.toThrow();
    expect(native.destroy).toHaveBeenCalledTimes(1);
    expect(native.translate).not.toHaveBeenCalled();
  });

  it('rejects an in-flight result that arrives after destruction', async () => {
    let finish: (text: string) => void = () => {};
    const native = { translate: () => new Promise<string>(resolve => { finish = resolve; }), destroy: vi.fn() };
    vi.stubGlobal('Translator', { availability: async () => 'available', create: async () => native });
    const local = await createLocalTranslator();
    const pending = local.translate('hello');
    local.destroy();
    finish('你好');
    await expect(pending).rejects.toThrow();
  });

  it('rejects a translation failure while preserving the local-only mode', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    vi.stubGlobal('Translator', {
      availability: async () => 'available',
      create: async () => ({ translate: async () => { throw new Error('Model failed'); }, destroy: vi.fn() }),
    });
    const local = await createLocalTranslator();
    await expect(local.translate('hello')).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    local.destroy();
  });
});
