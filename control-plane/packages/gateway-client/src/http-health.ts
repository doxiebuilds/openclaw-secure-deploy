import type { FleetGateway } from '@ocp/domain';

export type HttpHealthResult = {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
};

export async function checkHttpHealth(gw: FleetGateway, timeoutMs = 4000): Promise<HttpHealthResult> {
  const url = `${gw.hostHttpBase.replace(/\/$/, '')}${gw.healthzPath || '/healthz'}`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return {
      ok: res.ok,
      statusCode: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
