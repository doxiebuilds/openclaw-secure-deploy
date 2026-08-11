import { Message } from '@arco-design/web-react';

export const toast = {
  success: (content: string) => Message.success({ content, position: 'top' }),
  error: (content: string) => Message.error({ content, position: 'top', duration: 5000 }),
  info: (content: string) => Message.info({ content, position: 'top' }),
  warning: (content: string) => Message.warning({ content, position: 'top' }),
};
