// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useInterview } from '../hooks/useInterview';
import { DEFAULT_SETTINGS } from '../lib/session';
import type { TranscriptSegment } from '../types';
import { Workspace } from './Workspace';

type Interview = ReturnType<typeof useInterview>;
const first: TranscriptSegment = { id: 'first', english: 'What interests you about this role?', chinese: '這個職位有什麼吸引你？', time: 1, translationState: 'done' };
const latest: TranscriptSegment = { id: 'latest', english: 'How do you handle a tight deadline?', chinese: '你如何面對緊迫期限？', time: 5, translationState: 'done' };
const next: TranscriptSegment = { id: 'next', english: 'What happened next?', chinese: '接下來發生了什麼？', time: 8, translationState: 'done' };
function session(overrides: Partial<Interview> = {}): Interview {
  return {
    segments: [first, latest], interim: '', speechState: 'listening', error: '', notice: '', elapsed: 7,
    isDemo: false, hasSession: true, ended: false, selected: '', selectedId: '', answer: '', answerQuestion: '',
    answerBusy: false, answerError: '', usage: { spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 },
    sessionSettings: DEFAULT_SETTINGS, start: vi.fn(), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), select: vi.fn(),
    ask: vi.fn().mockResolvedValue(undefined), cancelAnswer: vi.fn(), updateConnection: vi.fn(), addManual: vi.fn(), retryTranslation: vi.fn(),
    ...overrides,
  };
}
function viewport(mobile: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('max-width') && mobile, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })));
}
function transcript() { return within(screen.getByRole('log', { name: '英中逐字稿' })); }
beforeEach(() => { viewport(true); Element.prototype.scrollTo = vi.fn(); });
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mobile caption reading', () => {
  it.each(['touchMove', 'wheel'] as const)('does not pin an empty caption after %s before speech arrives', event => {
    const s = session({ segments: [], interim: '' }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent[event](screen.getByRole('log', { name: '英中逐字稿' }));
    view.rerender(<Workspace session={{ ...s, interim: 'First spoken words' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText('First spoken words')).toBeTruthy();
    view.rerender(<Workspace session={{ ...s, segments: [first], interim: '' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(first.english)).toBeTruthy();
    expect(transcript().getByText(first.chinese)).toBeTruthy();
  });

  it('shows only the latest completed caption, with earlier captions available in history', () => {
    const s = session(); render(<Workspace session={s} onSettings={vi.fn()}/>);
    expect(transcript().queryByText(first.english)).toBeNull();
    expect(transcript().getByText(latest.english)).toBeTruthy();
    expect(transcript().getByText(latest.chinese)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看歷史字幕 (2)' }));
    expect(transcript().getByText(first.english)).toBeTruthy();
    fireEvent.click(transcript().getAllByRole('button', { name: '選取整段' })[0]);
    expect(s.select).toHaveBeenCalledWith(first.english, first.id);
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.retryTranslation).not.toHaveBeenCalled();
    expect(s.segments).toHaveLength(2);
  });

  it('updates a single interim caption in place, then replaces it with its completed translation', () => {
    const s = session({ interim: 'Tell me' }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    expect(transcript().queryByText(latest.english)).toBeNull();
    const current = transcript().getByText('Tell me');
    view.rerender(<Workspace session={{ ...s, interim: 'Tell me more about that' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText('Tell me more about that')).toBe(current);
    expect(transcript().getAllByRole('article')).toHaveLength(1);
    view.rerender(<Workspace session={{ ...s, interim: '', segments: [...s.segments, next] }} onSettings={vi.fn()}/>);
    expect(transcript().getAllByRole('article')).toHaveLength(1);
    expect(transcript().getByText(next.english)).toBeTruthy();
    expect(transcript().getByText(next.chinese)).toBeTruthy();
  });

  it('holds the chosen completed caption through incoming speech until returning to latest', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const paragraph = transcript().getByText(latest.english);
    fireEvent.click(transcript().getByRole('button', { name: '選取整段' }));
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next], interim: 'Another question' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(latest.english)).toBe(paragraph);
    expect(transcript().queryByText(next.english)).toBeNull();
    expect(transcript().queryByText('Another question')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /回到最新/ }));
    expect(transcript().queryByText(latest.english)).toBeNull();
    expect(transcript().getByText('Another question')).toBeTruthy();
  });

  it('preserves native text nodes and ranges while newer captions arrive', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const text = transcript().getByText(latest.english).firstChild!;
    act(() => {
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6);
      window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    });
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next], interim: 'More speech' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(latest.english).firstChild).toBe(text);
    expect(window.getSelection()?.toString()).toBe('How do');
    expect(window.getSelection()?.getRangeAt(0).startContainer).toBe(text);
    expect(transcript().queryByText('More speech')).toBeNull();
  });

  it('freezes a caption as native selection begins, before handles have formed a range', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const text = transcript().getByText(latest.english).firstChild!;
    act(() => text.dispatchEvent(new Event('selectstart', { bubbles: true })));
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next] }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(latest.english).firstChild).toBe(text);
    expect(transcript().queryByText(next.english)).toBeNull();
  });

  it('receives a held caption translation without replacing its selected English text node', () => {
    const pending = { ...latest, chinese: '', translationState: 'pending' as const };
    const s = session({ segments: [first, pending] }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const text = transcript().getByText(latest.english).firstChild!;
    act(() => {
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6);
      window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
    });
    view.rerender(<Workspace session={{ ...s, segments: [first, latest, next], interim: 'More speech' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(latest.chinese)).toBeTruthy();
    expect(transcript().queryByText('翻譯中…')).toBeNull();
    expect(transcript().getByText(latest.english).firstChild).toBe(text);
    expect(window.getSelection()?.toString()).toBe('How do');
    expect(transcript().queryByText(next.english)).toBeNull();
  });

  it('updates a held caption from a translation error through retry to success', () => {
    const failed = { ...latest, chinese: '', translationState: 'error' as const, error: 'Translation interrupted' };
    const s = session({ segments: [first, failed] }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const paragraph = transcript().getByText(latest.english);
    fireEvent.click(transcript().getByRole('button', { name: '選取整段' }));
    fireEvent.click(transcript().getByRole('button', { name: '重試' }));
    expect(s.retryTranslation).toHaveBeenCalledWith(failed);
    view.rerender(<Workspace session={{ ...s, segments: [first, { ...latest, chinese: '', translationState: 'pending' }] }} onSettings={vi.fn()}/>);
    expect(transcript().getByText('翻譯中…')).toBeTruthy();
    expect(transcript().queryByText('Translation interrupted')).toBeNull();
    view.rerender(<Workspace session={{ ...s, segments: [first, latest, next] }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(latest.chinese)).toBeTruthy();
    expect(transcript().queryByRole('button', { name: '重試' })).toBeNull();
    expect(transcript().getByText(latest.english)).toBe(paragraph);
    expect(transcript().queryByText(next.english)).toBeNull();
  });

  it('keeps the full transcript and interim visible on desktop', () => {
    viewport(false); const s = session({ interim: 'More speech' }); render(<Workspace session={s} onSettings={vi.fn()}/>);
    expect(transcript().getByText(first.english)).toBeTruthy();
    expect(transcript().getByText(latest.english)).toBeTruthy();
    expect(transcript().getByText('More speech')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /查看歷史字幕/ })).toBeNull();
  });
});
