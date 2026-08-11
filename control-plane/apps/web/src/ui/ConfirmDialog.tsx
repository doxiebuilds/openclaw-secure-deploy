import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};

/**
 * Replaces window.confirm() for destructive actions: shows the action's
 * consequence in a real dialog instead of the browser's unstyled prompt,
 * and supports an async confirm handler with its own busy state.
 */
export function useConfirmDialog() {
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void; busy: boolean }) | null
  >(null);

  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      setState({ ...options, resolve, busy: false });
    });
  }

  const node = state ? (
    <Modal
      visible
      size="small"
      title={state.title}
      onCancel={() => {
        state.resolve(false);
        setState(null);
      }}
      footer={
        <div className="flex justify-end gap-8px">
          <Button
            variant="text"
            onClick={() => {
              state.resolve(false);
              setState(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant={state.danger ? 'danger' : 'primary'}
            loading={state.busy}
            onClick={() => {
              state.resolve(true);
              setState(null);
            }}
          >
            {state.confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      }
    >
      {state.description ? <div className="text-14px text-ink-2">{state.description}</div> : null}
    </Modal>
  ) : null;

  return { confirm, node };
}
