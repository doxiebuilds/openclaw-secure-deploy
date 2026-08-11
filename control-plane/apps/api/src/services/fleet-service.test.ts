import { describe, expect, it } from 'vitest';
import type { GatewayConnector } from '@ocp/gateway-client';
import { FleetService } from './fleet-service.js';

const GATEWAYS = [
  { id: 'main', container: 'openclaw', hostHttpBase: 'http://127.0.0.1:1', healthzPath: '/healthz' },
  { id: 'scout', container: 'openclaw-scout', hostHttpBase: 'http://127.0.0.1:2', healthzPath: '/healthz' },
];

const PAYLOADS: Record<string, unknown> = {
  health: { ok: true },
  status: { version: '2026.7.1' },
  'agents.list': { defaultId: 'a1', agents: [{ id: 'a1' }, { id: 'a2' }] },
  'sessions.list': { sessions: [{ key: 'agent:a1:s1' }], totalCount: 1 },
  'cron.list': { jobs: [{ id: 'c1' }] },
  'exec.approval.list': [{ id: 'x1' }, { id: 'x2' }],
};

/** Records every RPC so we can assert the sweep does not repeat itself. */
function fakeConnector() {
  const calls: string[] = [];
  const connector = {
    listGateways: () => GATEWAYS,
    getGateway: (id: string) => GATEWAYS.find((g) => g.id === id)!,
    async tryCall(gatewayId: string, method: string) {
      calls.push(`${gatewayId}:${method}`);
      return { gatewayId, method, ok: true as const, data: PAYLOADS[method] ?? {}, durationMs: 1 };
    },
  };
  return { connector: connector as unknown as GatewayConnector, calls };
}

describe('FleetService.statusAllDetail', () => {
  it('issues each RPC exactly once per gateway', async () => {
    const { connector, calls } = fakeConnector();
    await new FleetService(connector).statusAllDetail();

    // 2 gateways x 6 RPCs. The dashboard used to re-issue agents.list and
    // exec.approval.list in later stages, costing 8 extra calls here.
    expect(calls).toHaveLength(12);
    expect(new Set(calls).size).toBe(12);

    for (const gw of ['main', 'scout']) {
      for (const m of ['health', 'status', 'agents.list', 'sessions.list', 'cron.list', 'exec.approval.list']) {
        expect(calls.filter((c) => c === `${gw}:${m}`)).toHaveLength(1);
      }
    }
  });

  it('returns the agents and exec approvals gathered during the sweep', async () => {
    const { connector } = fakeConnector();
    const details = await new FleetService(connector).statusAllDetail();

    expect(details).toHaveLength(2);
    expect(details.flatMap((d) => d.agents).map((a) => a.id)).toEqual(['a1', 'a2', 'a1', 'a2']);
    expect(details.flatMap((d) => d.execApprovals)).toHaveLength(4);
    // Derived counts must agree with the collections they came from.
    for (const d of details) {
      expect(d.status.agentCount).toBe(d.agents.length);
      expect(d.status.pendingApprovals).toBe(d.execApprovals.length);
    }
  });

  it('statusAll stays a projection of statusAllDetail', async () => {
    const { connector } = fakeConnector();
    const service = new FleetService(connector);
    const statuses = await service.statusAll();
    expect(statuses.map((s) => s.gatewayId)).toEqual(['main', 'scout']);
  });
});
