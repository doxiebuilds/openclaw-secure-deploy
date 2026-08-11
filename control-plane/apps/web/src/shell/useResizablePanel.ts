import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Free-drag resizable panel width, persisted to localStorage. Used for the
 * right-hand workspace panel. Drag direction is "reverse" (dragging left
 * grows the panel) since it sits on the right edge of the layout.
 */
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
}: {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      if (stored && stored >= minWidth && stored <= maxWidth) return stored;
    } catch {
      // ignore
    }
    return defaultWidth;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      // ignore
    }
  }, [storageKey, width]);

  const dragState = useRef<{ active: boolean; startX: number; startWidth: number }>({
    active: false,
    startX: 0,
    startWidth: width,
  });

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      dragState.current = { active: true, startX: event.clientX, startWidth: width };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width]
  );

  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (!dragState.current.active) return;
      const delta = dragState.current.startX - event.clientX;
      const next = Math.min(maxWidth, Math.max(minWidth, dragState.current.startWidth + delta));
      setWidth(next);
    }
    function onUp() {
      if (!dragState.current.active) return;
      dragState.current.active = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [minWidth, maxWidth]);

  return { width, onPointerDown };
}
