import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function GatewayLink({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <Link to={`/gateways/${id}`} className="text-accent hover:underline capitalize">
      {children ?? id}
    </Link>
  );
}

export function AgentLink({
  gatewayId,
  agentId,
  children,
}: {
  gatewayId: string;
  agentId: string;
  children?: ReactNode;
}) {
  return (
    <Link to={`/gateways/${gatewayId}/agents/${agentId}`} className="text-accent hover:underline">
      {children ?? agentId}
    </Link>
  );
}
