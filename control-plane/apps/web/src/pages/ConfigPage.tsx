import { useEffect, useState } from 'react';
import useSWR from 'swr';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { api } from '../api';
import { Card, PageHeader, PageLoading, Badge, Button, Select, RelativeTime } from '../ui';
import { DataTable, type Column } from '../ui/DataTable';
import { Modal } from '../ui/Modal';
import { DiffView } from '../ui/DiffView';
import { useConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from '../ui/toast';
import { useTheme } from '../theme/ThemeProvider';

type Version = { id: string; hash: string; createdAt: string; author: string; note: string | null; source: string };
type Live = {
  gatewayId: string;
  hostPath: string;
  hostHash: string | null;
  rpcHash: string | null;
  valid: boolean | null;
  hostRawPreview: string | null;
  applyMode: string;
};

export function ConfigPage() {
  const [gatewayId, setGatewayId] = useState('main');
  const { data, mutate, isLoading } = useSWR<{ live: Live; versions: Version[] }>(`/api/config/${gatewayId}`);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const { confirm, node: confirmNode } = useConfirmDialog();
  const { resolved } = useTheme();

  const live = data?.live ?? null;
  const versions = data?.versions ?? [];

  useEffect(() => {
    setDraft('');
    setJsonError(null);
  }, [gatewayId]);

  useEffect(() => {
    if (live?.hostRawPreview && !draft) setDraft(live.hostRawPreview);
  }, [live, draft]);

  function onDraftChange(value: string) {
    setDraft(value);
    try {
      JSON.parse(value);
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  }

  async function snapshot() {
    setBusy(true);
    try {
      await api(`/api/config/${gatewayId}/snapshot`, { method: 'POST', body: JSON.stringify({ note: 'manual snapshot' }) });
      toast.success('Snapshot saved');
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function propose() {
    if (jsonError) {
      toast.error('Fix JSON errors before proposing');
      return;
    }
    setBusy(true);
    try {
      const document = JSON.parse(draft) as unknown;
      const res = await api<{ version: Version }>(`/api/config/${gatewayId}/propose`, {
        method: 'POST',
        body: JSON.stringify({ document, note: 'UI propose' }),
      });
      toast.success(`Proposed version ${res.version.id}`);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function apply(versionId: string) {
    const ok = await confirm({
      title: 'Apply this version?',
      description: 'This writes the host openclaw.json file. You may need to restart the gateway afterward.',
      confirmLabel: 'Apply',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api<{ warning?: string }>(`/api/config/${gatewayId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ versionId, expectedHostHash: live?.hostHash }),
      });
      toast.success(res.warning || 'Applied');
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    const ok = await confirm({
      title: 'Rollback to previous version?',
      description: 'Restores the previous snapshot/applied version to the host file.',
      confirmLabel: 'Rollback',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api<{ warning?: string }>(`/api/config/${gatewayId}/rollback`, { method: 'POST' });
      toast.success(res.warning || 'Rolled back');
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const versionColumns: Column<Version>[] = [
    { key: 'when', header: 'When', render: (v) => <RelativeTime value={v.createdAt} /> },
    { key: 'source', header: 'Source', render: (v) => v.source },
    { key: 'hash', header: 'Hash', render: (v) => <span className="font-mono text-ink-2">{v.hash.slice(0, 12)}…</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (v) => (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void apply(v.id)}>
          Apply
        </Button>
      ),
    },
  ];

  if (isLoading && !data) return <PageLoading />;

  return (
    <div>
      <PageHeader
        title="Configuration"
        subtitle="Host-mediated OpenClaw config. Containers mount openclaw.json read-only — apply writes the host file."
        actions={
          <Select value={gatewayId} onChange={(e) => setGatewayId(e.target.value)} style={{ width: 160 }}>
            <option value="main">main</option>
            <option value="scout">scout</option>
            <option value="curator">curator</option>
          </Select>
        }
      />

      {live ? (
        <Card className="mb-14px">
          <div className="flex items-center gap-8px flex-wrap">
            <Badge>host {live.hostHash?.slice(0, 12) ?? '—'}…</Badge>
            <Badge>rpc {live.rpcHash?.slice(0, 12) ?? '—'}…</Badge>
            <Badge tone={live.valid ? 'success' : 'warning'}>{live.valid ? 'Valid' : 'Invalid/unknown'}</Badge>
            <Badge>{live.applyMode}</Badge>
          </div>
          <div className="font-mono text-12px text-ink-3 mt-8px">{live.hostPath}</div>
          <div className="flex items-center gap-8px mt-12px flex-wrap">
            <Button disabled={busy} onClick={() => void snapshot()}>
              Snapshot current
            </Button>
            <Button disabled={busy} onClick={() => void rollback()}>
              Rollback previous
            </Button>
            <Button disabled={busy} onClick={() => void mutate()}>
              Refresh
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-14px">
        <Card title="Editor (propose)">
          <p className="text-13px text-ink-2 -mt-4px mb-10px">
            Edit JSON, preview the diff, then propose a version. Secrets in plaintext are rejected.
          </p>
          <div className="rd-10px overflow-hidden border border-edge">
            <CodeMirror
              value={draft}
              height="360px"
              theme={resolved}
              extensions={[json()]}
              onChange={onDraftChange}
            />
          </div>
          {jsonError ? <div className="text-13px text-bad mt-8px">{jsonError}</div> : null}
          <div className="flex items-center gap-8px mt-12px">
            <Button variant="primary" disabled={busy || Boolean(jsonError)} onClick={() => void propose()}>
              Propose version
            </Button>
            <Button
              disabled={!live?.hostRawPreview}
              onClick={() => setDiffOpen(true)}
            >
              Preview diff
            </Button>
          </div>
        </Card>
        <Card title="Versions" padded={false}>
          <DataTable columns={versionColumns} rows={versions} rowKey={(v) => v.id} emptyTitle="No versions yet — snapshot first" />
        </Card>
      </div>

      <Modal visible={diffOpen} onCancel={() => setDiffOpen(false)} title="Diff vs. live host file" size="xlarge">
        <DiffView before={live?.hostRawPreview ?? ''} after={draft} beforeLabel="host" afterLabel="draft" />
      </Modal>
      {confirmNode}
    </div>
  );
}
