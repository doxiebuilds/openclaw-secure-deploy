import { Modal as ArcoModal } from '@arco-design/web-react';
import type { ReactNode } from 'react';

const SIZE: Record<'small' | 'medium' | 'large' | 'xlarge' | 'full', { width: number | string }> = {
  small: { width: 400 },
  medium: { width: 600 },
  large: { width: 800 },
  xlarge: { width: 1000 },
  full: { width: '90vw' },
};

export function Modal({
  visible,
  onCancel,
  title,
  children,
  footer,
  size = 'medium',
}: {
  visible: boolean;
  onCancel: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZE;
}) {
  return (
    <ArcoModal
      visible={visible}
      onCancel={onCancel}
      title={title}
      footer={footer ?? null}
      style={{ width: SIZE[size].width }}
      maskClosable
      unmountOnExit
    >
      {children}
    </ArcoModal>
  );
}
