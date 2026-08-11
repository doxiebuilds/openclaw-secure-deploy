import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_WIDTH = 260;
const SNAP_THRESHOLD = Math.round(DEFAULT_WIDTH / 2);
const HYSTERESIS = 6;

/**
 * Sider collapse: a plain toggle (button / ⌘B), plus an optional drag-snap
 * on the boundary strip — dragging past the midpoint snaps collapsed/expanded
 * rather than free-resizing. The hysteresis
 * band stops it flickering right at the threshold.
 */
export function useSiderCollapse() {
  const [collapsed, setCollapsed] = useState(false);
  const collapsedRef = useRef(collapsed);
  const dragState = useRef<{ active: boolean; startX: number }>({ active: false, startX: 0 });

  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((v) => !v), []);

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    dragState.current = { active: true, startX: event.clientX };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (!dragState.current.active) return;
      const draggedWidth = (collapsedRef.current ? 0 : DEFAULT_WIDTH) + (event.clientX - dragState.current.startX);
      const shouldCollapse = collapsedRef.current
        ? draggedWidth < SNAP_THRESHOLD + HYSTERESIS
        : draggedWidth <= SNAP_THRESHOLD - HYSTERESIS;
      if (shouldCollapse !== collapsedRef.current) setCollapsed(shouldCollapse);
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
  }, []);

  return { collapsed, toggle, setCollapsed, onPointerDown, width: DEFAULT_WIDTH };
}
