/**
 * Pre-wrapped IconPark icons with consistent defaults, so every icon in the
 * app shares the same stroke weight and color without a build-time transform.
 */
import type { ComponentProps, ComponentType } from 'react';
import {
  AddOne,
  Application,
  Attention,
  Audit,
  CheckOne,
  CloseSmall,
  Config,
  Connect,
  CopyOne,
  Dashboard,
  Delete,
  Down,
  Edit,
  ExpandLeft,
  FolderOpen,
  History,
  Layers,
  Left,
  Loading,
  Lock,
  Moon,
  More,
  PlayOne,
  Right,
  RefreshOne,
  Robot,
  Send,
  Server,
  SettingTwo,
  Shield,
  Sun,
  Terminal,
  Up,
  User,
} from '@icon-park/react';

type IconProps = ComponentProps<typeof CheckOne>;

function wrap(Base: ComponentType<IconProps>) {
  return function WrappedIcon({ style, ...props }: IconProps) {
    // IconPark wraps SVGs in an inline <span.i-icon>. Without a fixed line-box,
    // color/paint changes on hover can baseline-shift the icon (reads as a jump).
    return (
      <Base
        size={16}
        strokeWidth={3}
        fill="currentColor"
        theme="outline"
        style={{ display: 'inline-flex', lineHeight: 0, verticalAlign: 'middle', ...style }}
        {...props}
      />
    );
  };
}

export const Icon = {
  Add: wrap(AddOne),
  App: wrap(Application),
  Attention: wrap(Attention),
  Audit: wrap(Audit),
  Check: wrap(CheckOne),
  Close: wrap(CloseSmall),
  Config: wrap(Config),
  Connect: wrap(Connect),
  Copy: wrap(CopyOne),
  Dashboard: wrap(Dashboard),
  Delete: wrap(Delete),
  Down: wrap(Down),
  Edit: wrap(Edit),
  ExpandLeft: wrap(ExpandLeft),
  Folder: wrap(FolderOpen),
  History: wrap(History),
  Layers: wrap(Layers),
  Left: wrap(Left),
  Loading: wrap(Loading),
  Lock: wrap(Lock),
  Moon: wrap(Moon),
  More: wrap(More),
  Play: wrap(PlayOne),
  Right: wrap(Right),
  Refresh: wrap(RefreshOne),
  Robot: wrap(Robot),
  Send: wrap(Send),
  Server: wrap(Server),
  Settings: wrap(SettingTwo),
  Shield: wrap(Shield),
  Sun: wrap(Sun),
  Terminal: wrap(Terminal),
  Up: wrap(Up),
  User: wrap(User),
};
