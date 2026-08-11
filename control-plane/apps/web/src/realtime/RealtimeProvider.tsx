import { createContext, useContext, type ReactNode } from 'react';
import { useFleetStream, type ConnectionState } from './useFleetStream';

const ConnectionContext = createContext<ConnectionState>('connecting');

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const state = useFleetStream();
  return <ConnectionContext.Provider value={state}>{children}</ConnectionContext.Provider>;
}

export function useConnectionState() {
  return useContext(ConnectionContext);
}
