import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface SelectionCallbacks {
  onSelect: (text: string) => void;
  onSelectionStart: () => void;
}

/** Native mobile selection handles can change a range without pointerup or keyup. */
export function useTranscriptSelection(container: RefObject<HTMLElement | null>, callbacks: SelectionCallbacks) {
  const latest = useRef(callbacks);
  useLayoutEffect(() => { latest.current = callbacks; }, [callbacks]);

  const captureSelection = useCallback(() => {
    const element = container.current;
    const selection = element?.ownerDocument.getSelection();
    if (!element || !selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    const text = selection.toString().trim();
    if (!text) return;
    latest.current.onSelectionStart();
    latest.current.onSelect(text);
    // A collapsed range must never clear the app's saved question snapshot.
  }, [container]);

  useEffect(() => {
    const onChange = (event: Event) => {
      // Input/textarea selectionchange can bubble; those are not transcript ranges.
      if (event.target === document) captureSelection();
    };
    const onStart = (event: Event) => {
      if (event.target instanceof Node && container.current?.contains(event.target)) latest.current.onSelectionStart();
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('selectstart', onStart);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('selectstart', onStart);
    };
  }, [captureSelection, container]);

  return captureSelection;
}
