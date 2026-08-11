import { useState } from 'react';
import useSWR from 'swr';
import { api } from '../api';
import { Card, PageHeader, PageLoading, Badge, Button, Icon } from '../ui';
import { CodeBlock } from '../ui/CodeBlock';
import { toast } from '../ui/toast';

type Posture = { bindDefault: string; connector: string; hostWsTokenOnlyScopes: boolean; notes: string[] };
type CheckResult = { ok: boolean; tool: string; exitCode: number | null; stdout: string; stderr: string; summary: string };

export function SecurityPage() {
  const { data, isLoading } = useSWR<{ posture: Posture }>('/api/security/posture');
  const [enclave, setEnclave] = useState<CheckResult | null>(null);
  const [drift, setDrift] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<'enclave' | 'drift' | null>(null);

  async function runEnclave() {
    setBusy('enclave');
    try {
      const res = await api<{ result: CheckResult }>('/api/security/enclave-check', { method: 'POST' });
      setEnclave(res.result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runDrift() {
    setBusy('drift');
    try {
      const res = await api<{ result: CheckResult }>('/api/security/approvals-drift', { method: 'POST' });
      setDrift(res.result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (isLoading && !data) return <PageLoading />;
  const posture = data?.posture ?? null;

  return (
    <div>
      <PageHeader title="Security" subtitle="Enclave static checks, policy drift, and control-plane posture." />

      {posture ? (
        <Card title="Posture" className="mb-14px">
          <div className="flex items-center gap-8px flex-wrap mb-10px">
            <Badge>bind {posture.bindDefault}</Badge>
            <Badge>connector {posture.connector}</Badge>
            <Badge tone={posture.hostWsTokenOnlyScopes ? 'success' : 'warning'}>
              host WS scopes {posture.hostWsTokenOnlyScopes ? 'yes' : 'no'}
            </Badge>
          </div>
          <ul className="m-0 pl-18px">
            {posture.notes.map((n) => (
              <li key={n} className="text-13px text-ink-2 mb-4px">
                {n}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="flex items-center gap-8px mb-14px">
        <Button variant="primary" icon={<Icon.Shield size={14} />} loading={busy === 'enclave'} onClick={() => void runEnclave()}>
          Run enclave-check
        </Button>
        <Button icon={<Icon.Check size={14} />} loading={busy === 'drift'} onClick={() => void runDrift()}>
          Run check-approvals (main)
        </Button>
      </div>

      {enclave ? (
        <Card className="mb-14px" title={
          <span className="flex items-center gap-8px">
            enclave-check
            <Badge tone={enclave.ok ? 'success' : 'danger'}>{enclave.summary}</Badge>
          </span>
        }>
          <CodeBlock code={enclave.stdout || enclave.stderr || '(no output)'} />
        </Card>
      ) : null}

      {drift ? (
        <Card title={
          <span className="flex items-center gap-8px">
            check-approvals
            <Badge tone={drift.ok ? 'success' : 'danger'}>{drift.summary}</Badge>
          </span>
        }>
          <CodeBlock code={drift.stdout || drift.stderr || '(no output)'} />
        </Card>
      ) : null}
    </div>
  );
}
