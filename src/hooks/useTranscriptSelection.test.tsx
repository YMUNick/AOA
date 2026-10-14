// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptSelection } from './useTranscriptSelection';

function fixture() {
  const before = document.createElement('p'); before.textContent = 'Outside before';
  const container = document.createElement('div');
  const paragraph = document.createElement('p'); paragraph.textContent = 'What is your role?'; container.append(paragraph);
  const after = document.createElement('p'); after.textContent = 'Outside after';
  document.body.append(before, container, after);
  return { ref: { current: container as HTMLElement | null }, text: paragraph.firstChild!, before: before.firstChild!, after: after.firstChild! };
}
function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange(); range.setStart(start, startOffset); range.setEnd(end, endOffset);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });

describe('native transcript selection', () => {
  it('captures selectionchange and subsequent handle adjustments without pointer or key events', () => {
    const { ref, text } = fixture(); const onSelect = vi.fn(), onSelectionStart = vi.fn();
    renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart }));
    act(() => select(text, 0, text, 4));
    expect(onSelect).toHaveBeenLastCalledWith('What');
    act(() => select(text, 0, text, 12));
    expect(onSelect).toHaveBeenLastCalledWith('What is your');
    expect(onSelectionStart).toHaveBeenCalled();
  });

  it('never replaces a snapshot with collapsed or cleared native selection', () => {
    const { ref, text } = fixture(); const onSelect = vi.fn();
    renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart: vi.fn() }));
    act(() => select(text, 0, text, 4));
    act(() => select(text, 4, text, 4));
    act(() => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    expect(onSelect.mock.calls).toEqual([['What']]);
  });

  it('ignores outside selection and ranges crossing either container boundary', () => {
    const { ref, text, before, after } = fixture(); const onSelect = vi.fn(), onSelectionStart = vi.fn();
    renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart }));
    act(() => select(before, 0, before, 7));
    act(() => select(before, 0, text, 4));
    act(() => select(text, 0, after, 7));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSelectionStart).not.toHaveBeenCalled();
  });

  it('freezes follow when native selection begins inside the transcript, before text exists', () => {
    const { ref, text, before } = fixture(); const onSelect = vi.fn(), onSelectionStart = vi.fn();
    renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart }));
    act(() => before.dispatchEvent(new Event('selectstart', { bubbles: true })));
    expect(onSelectionStart).not.toHaveBeenCalled();
    act(() => text.dispatchEvent(new Event('selectstart', { bubbles: true })));
    expect(onSelectionStart).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('ignores a textarea selectionchange that bubbles while a transcript range still exists', () => {
    const { ref, text } = fixture(); const onSelect = vi.fn(), onSelectionStart = vi.fn();
    const textarea = document.createElement('textarea'); document.body.append(textarea);
    renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart }));
    act(() => select(text, 0, text, 4)); onSelect.mockClear(); onSelectionStart.mockClear();
    act(() => textarea.dispatchEvent(new Event('selectionchange', { bubbles: true })));
    expect(onSelect).not.toHaveBeenCalled(); expect(onSelectionStart).not.toHaveBeenCalled();
  });

  it('uses newly committed callbacks when props change', () => {
    const { ref, text } = fixture(); const oldSelect = vi.fn(), nextSelect = vi.fn(), oldStart = vi.fn(), nextStart = vi.fn();
    const { rerender } = renderHook(({ onSelect, onSelectionStart }) => useTranscriptSelection(ref, { onSelect, onSelectionStart }), { initialProps: { onSelect: oldSelect, onSelectionStart: oldStart } });
    rerender({ onSelect: nextSelect, onSelectionStart: nextStart });
    act(() => select(text, 0, text, 4));
    expect(nextSelect).toHaveBeenCalledWith('What');
    expect(nextStart).toHaveBeenCalled();
    expect(oldSelect).not.toHaveBeenCalled(); expect(oldStart).not.toHaveBeenCalled();
  });

  it('removes document listeners when unmounted', () => {
    const { ref, text } = fixture(); const onSelect = vi.fn(), onSelectionStart = vi.fn();
    const { unmount } = renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart }));
    unmount();
    act(() => { select(text, 0, text, 4); text.dispatchEvent(new Event('selectstart', { bubbles: true })); });
    expect(onSelect).not.toHaveBeenCalled(); expect(onSelectionStart).not.toHaveBeenCalled();
  });

  it('returns a capture fallback for pointer/key events and reads the current container ref', () => {
    const { ref, text } = fixture(); const onSelect = vi.fn();
    const { result } = renderHook(() => useTranscriptSelection(ref, { onSelect, onSelectionStart: vi.fn() }));
    act(() => select(text, 0, text, 4)); onSelect.mockClear();
    act(() => result.current());
    expect(onSelect).toHaveBeenCalledWith('What');
    ref.current = null; onSelect.mockClear();
    act(() => result.current());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
