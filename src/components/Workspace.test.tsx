// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useInterview } from '../hooks/useInterview';
import { DEFAULT_SETTINGS } from '../lib/session';
import type { TranscriptSegment } from '../types';
import { Workspace } from './Workspace';
import type { TabAudioCapture } from '../lib/tabAudio';

const tabAudio = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/tabAudio', () => ({ requestTabAudio: tabAudio.request }));

type Interview = ReturnType<typeof useInterview>;
const first: TranscriptSegment = { id: 'first', english: 'What interests you about this role?', chinese: '這個職位有什麼吸引你？', time: 1, translationState: 'done' };
const latest: TranscriptSegment = { id: 'latest', english: 'How do you handle a tight deadline?', chinese: '你如何面對緊迫期限？', time: 5, translationState: 'done' };
const next: TranscriptSegment = { id: 'next', english: 'What happened next?', chinese: '接下來發生了什麼？', time: 8, translationState: 'done' };
function session(overrides: Partial<Interview> = {}): Interview {
  return {
    segments: [first, latest], interim: '', speechState: 'listening', error: '', notice: '', elapsed: 7,
    isDemo: false, hasSession: true, ended: false, finishing: false, bufferMs: 0, selected: '', selectedId: '', answer: '', answerQuestion: '',
    answerBusy: false, answerError: '', usage: { spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 },
    sessionSettings: DEFAULT_SETTINGS, start: vi.fn(), pause: vi.fn().mockResolvedValue(undefined), resume: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), select: vi.fn(),
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
let resizeContent: () => void;
beforeEach(() => {
  tabAudio.request.mockReset();
  viewport(true);
  resizeContent = () => {};
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  Element.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
    this.scrollTop = Math.min(this.scrollHeight - this.clientHeight, typeof options === 'object' ? options.top ?? 0 : 0);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeContent = () => callback([], this as unknown as ResizeObserver); }
    observe() {} disconnect() {} unobserve() {}
  });
});
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function log() { return screen.getByRole('log', { name: '英中逐字稿' }); }
function grow(height: number) { Object.defineProperty(log(), 'scrollHeight', { configurable: true, value: height }); }
function selectText(text: Node) {
  act(() => {
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6);
    window.getSelection()!.addRange(range); document.dispatchEvent(new Event('selectionchange'));
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function capture() {
  return { track: {} as MediaStreamTrack, setRecognitionActive: vi.fn(), setCallbacks: vi.fn(), finish: vi.fn().mockResolvedValue(true), close: vi.fn() };
}
const tabSettings = { ...DEFAULT_SETTINGS, audioSource: 'tab' as const };

describe('meeting tab controls', () => {
  it('keeps uncertain recognition visibly labelled alongside both languages even when selected', () => {
    render(<Workspace session={session({ segments: [{ ...first, recognitionState: 'unconfirmed' }], selectedId: first.id })} onSettings={vi.fn()}/>);
    expect(transcript().getByText(/辨識未確認/)).toBeTruthy();
    expect(transcript().getByText(first.english)).toBeTruthy(); expect(transcript().getByText(first.chinese)).toBeTruthy();
  });
  it('shows draining feedback and blocks conflicting session actions while retaining the transcript', () => {
    render(<Workspace session={session({ sessionSettings: tabSettings, finishing: true, bufferMs: 2500 })} onSettings={vi.fn()}/>);
    expect(screen.getByText('正在收尾')).toBeTruthy();
    expect((screen.getByRole('button', { name: '本次設定' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '結束訪談' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '重新選擇分頁' }) as HTMLButtonElement).disabled).toBe(true);
    expect(transcript().getByText(first.chinese)).toBeTruthy();
  });
  it('opens the picker directly from the click, then waits for the prior capture to finish before resuming', async () => {
    const paused = deferred<void>(), picked = deferred<TabAudioCapture>(), input = capture();
    tabAudio.request.mockReturnValue(picked.promise);
    const s = session({ sessionSettings: tabSettings, pause: vi.fn().mockReturnValue(paused.promise) });
    render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: '重新選擇分頁' }));
    expect(tabAudio.request).toHaveBeenCalledTimes(1); expect(s.pause).toHaveBeenCalledTimes(1);
    await act(async () => { picked.resolve(input); }); expect(s.resume).not.toHaveBeenCalled();
    await act(async () => { paused.resolve(); });
    expect(s.resume).toHaveBeenCalledWith(input); expect(s.start).not.toHaveBeenCalled();
    expect(transcript().getByText(first.chinese)).toBeTruthy();
  });
  it('keeps the session paused after a cancelled picker without a microphone fallback or clearing rows', async () => {
    tabAudio.request.mockRejectedValue(new Error('已取消選擇會議分頁。'));
    const s = session({ sessionSettings: tabSettings, speechState: 'paused' });
    render(<Workspace session={s} onSettings={vi.fn()}/>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新選擇分頁' })); });
    expect(screen.getByRole('alert').textContent).toContain('已取消');
    expect(s.resume).not.toHaveBeenCalled(); expect(s.start).not.toHaveBeenCalled();
    expect(transcript().getByText(first.chinese)).toBeTruthy();
  });
  it('closes a late picker result after leaving the workspace without attaching it to the session', async () => {
    const picked = deferred<TabAudioCapture>(), input = capture(); tabAudio.request.mockReturnValue(picked.promise);
    const s = session({ sessionSettings: tabSettings });
    const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button', { name: '重新選擇分頁' })); view.unmount();
    await act(async () => { picked.resolve(input); });
    expect(input.close).toHaveBeenCalledTimes(1); expect(s.resume).not.toHaveBeenCalled();
  });
});

describe('accumulating bilingual transcript', () => {
  it.each([true, false])('appends every bilingual row and follows its bottom with mobile=%s', mobile => {
    viewport(mobile); const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    expect(transcript().getByText(first.english)).toBeTruthy();
    expect(transcript().getByText(first.chinese)).toBeTruthy();
    expect(transcript().getByText(latest.english)).toBeTruthy();
    expect(log().scrollTop).toBe(800);
    grow(1300);
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next] }} onSettings={vi.fn()}/>);
    expect(transcript().getAllByRole('article')).toHaveLength(3);
    expect(transcript().getByText(next.chinese)).toBeTruthy();
    expect(log().scrollTop).toBe(1100);
    expect(screen.queryByRole('button', { name: /歷史字幕/ })).toBeNull();
  });

  it('keeps all completed captions while updating one interim paragraph in place', () => {
    const s = session({ interim: 'Tell me' }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const interim = transcript().getByText('Tell me');
    view.rerender(<Workspace session={{ ...s, interim: 'Tell me more' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText('Tell me more')).toBe(interim);
    expect(transcript().getAllByRole('article')).toHaveLength(3);
    expect(transcript().getByText(first.chinese)).toBeTruthy();
  });

  it('keeps the reading position after an upward scroll while new rows still append', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent.scroll(log(), { target: { scrollTop: 300 } });
    grow(1400);
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next], interim: 'More speech' }} onSettings={vi.fn()}/>);
    act(() => resizeContent());
    expect(log().scrollTop).toBe(300);
    expect(transcript().getByText(next.chinese)).toBeTruthy();
    expect(transcript().getByText('More speech')).toBeTruthy();
    expect(screen.getByText('閱讀中，畫面保持原位')).toBeTruthy();
  });

  it('resumes following with return-to-latest, and ignores its resulting scroll event', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent.scroll(log(), { target: { scrollTop: 300 } });
    fireEvent.click(screen.getByRole('button', { name: /回到最新/ }));
    expect(log().scrollTop).toBe(800);
    fireEvent.scroll(log());
    grow(1200);
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next] }} onSettings={vi.fn()}/>);
    expect(log().scrollTop).toBe(1000);
  });

  it('naturally resumes following when scrolling back down to the bottom', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent.scroll(log(), { target: { scrollTop: 300 } });
    fireEvent.scroll(log(), { target: { scrollTop: 800 } });
    grow(1200);
    view.rerender(<Workspace session={{ ...s, interim: 'Next question' }} onSettings={vi.fn()}/>);
    expect(log().scrollTop).toBe(1000);
  });

  it('preserves selected text and its scroll position when translation and newer rows arrive', () => {
    const pending = { ...latest, chinese: '', translationState: 'pending' as const };
    const s = session({ segments: [first, pending] }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    const text = transcript().getByText(latest.english).firstChild!;
    selectText(text);
    fireEvent.scroll(log(), { target: { scrollTop: 300 } });
    fireEvent.scroll(log(), { target: { scrollTop: 800 } });
    grow(1400);
    view.rerender(<Workspace session={{ ...s, segments: [first, latest, next], interim: 'More speech' }} onSettings={vi.fn()}/>);
    act(() => resizeContent());
    expect(transcript().getByText(latest.english).firstChild).toBe(text);
    expect(window.getSelection()?.toString()).toBe('How do');
    expect(transcript().getByText(latest.chinese)).toBeTruthy();
    expect(transcript().getByText(next.chinese)).toBeTruthy();
    expect(log().scrollTop).toBe(800);
  });

  it('does not resume from an unchanged scroll event after selecting a whole row', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent.click(transcript().getAllByRole('button', { name: '選取整段' })[0]);
    fireEvent.scroll(log());
    grow(1300);
    view.rerender(<Workspace session={{ ...s, segments: [...s.segments, next] }} onSettings={vi.fn()}/>);
    expect(log().scrollTop).toBe(800);
    expect(transcript().getByText(next.english)).toBeTruthy();
    expect(s.select).toHaveBeenCalledWith(first.english, first.id);
    expect(s.ask).not.toHaveBeenCalled();
  });

  it('follows translated content growth only while following is enabled', () => {
    render(<Workspace session={session()} onSettings={vi.fn()}/>);
    grow(1200); act(() => resizeContent());
    expect(log().scrollTop).toBe(1000);
    fireEvent.scroll(log(), { target: { scrollTop: 250 } });
    grow(1400); act(() => resizeContent());
    expect(log().scrollTop).toBe(250);
  });

  it('does not treat a hidden panel resetting its scroll position as an upward reading gesture', () => {
    const s = session(); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    Object.defineProperty(log(), 'clientHeight', { configurable: true, value: 0 });
    fireEvent.scroll(log(), { target: { scrollTop: 0 } });
    Object.defineProperty(log(), 'clientHeight', { configurable: true, value: 200 });
    grow(1200);
    view.rerender(<Workspace session={{ ...s, interim: 'More speech' }} onSettings={vi.fn()}/>);
    expect(log().scrollTop).toBe(1000);
  });

  it.each(['touchMove', 'wheel'] as const)('still displays arriving captions after %s on an empty transcript', event => {
    const s = session({ segments: [] }); const view = render(<Workspace session={s} onSettings={vi.fn()}/>);
    fireEvent[event](log());
    view.rerender(<Workspace session={{ ...s, interim: 'First words' }} onSettings={vi.fn()}/>);
    expect(transcript().getByText('First words')).toBeTruthy();
    view.rerender(<Workspace session={{ ...s, segments: [first] }} onSettings={vi.fn()}/>);
    expect(transcript().getByText(first.chinese)).toBeTruthy();
  });
});
