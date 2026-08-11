import { useEffect } from 'react';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable || Boolean(target.closest('.cm-editor'));
}

export function useShortcuts({
  onToggleSider,
  onToggleWorkspace,
  onToggleTheme,
}: {
  onToggleSider: () => void;
  onToggleWorkspace: () => void;
  onToggleTheme: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing) return;
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      if (isEditableTarget(event.target) && event.key !== '\\') return;

      if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        onToggleSider();
      } else if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        onToggleWorkspace();
      } else if (event.key === '\\') {
        event.preventDefault();
        onToggleTheme();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onToggleSider, onToggleWorkspace, onToggleTheme]);
}
