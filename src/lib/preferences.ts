import type { Settings } from '../types';

const STORAGE_KEY = 'aoa.preferences.v1';
type Preferences = Pick<Settings, 'translationMode' | 'provider' | 'connectionMode'>;

export function readPreferences(): Preferences | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.version !== 1
      || (data.translationMode !== 'local' && data.translationMode !== 'cloud' && data.translationMode !== 'off')
      || (data.provider !== 'openai' && data.provider !== 'gemini')
      || (data.connectionMode !== 'personal' && data.connectionMode !== 'gateway')) return null;
    return {
      translationMode: data.translationMode,
      provider: data.connectionMode === 'gateway' ? 'openai' : data.provider,
      connectionMode: data.connectionMode,
    };
  } catch {
    return null;
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      translationMode: preferences.translationMode,
      provider: preferences.connectionMode === 'gateway' ? 'openai' : preferences.provider,
      connectionMode: preferences.connectionMode,
    }));
  } catch {
    // Storage may be unavailable or full; the current tab still keeps its choices.
  }
}
