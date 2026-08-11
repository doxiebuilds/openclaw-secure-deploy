import { Drawer as ArcoDrawer } from '@arco-design/web-react';
import type { ReactNode } from 'react';

export function Drawer({
  visible,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  visible: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <ArcoDrawer
      visible={visible}
      onCancel={onClose}
      title={title}
      footer={footer ?? null}
      width={width}
      unmountOnExit
      okText="Close"
    >
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </ArcoDrawer>
  );
}
