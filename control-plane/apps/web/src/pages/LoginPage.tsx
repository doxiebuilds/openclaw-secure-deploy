import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Button, Card, Input, Label, Logo } from '../ui';

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && user) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-100vh ocp-center bg-canvas p-24px">
      <form onSubmit={(e) => void onSubmit(e)} className="w-full" style={{ maxWidth: 380 }}>
        <Card>
          <div className="mb-20px">
            <div className="flex items-center gap-10px mb-16px">
              <Logo />
              <span className="text-16px font-semibold text-ink">OpenClaw Control Plane</span>
            </div>
            <p className="text-13px text-ink-2 m-0">Sign in with your operator account to manage the fleet.</p>
          </div>

          {error ? (
            <div className="mb-14px px-12px py-10px rd-10px text-13px text-bad bg-[var(--ocp-bad-soft)] border border-[var(--ocp-bad-edge)]">
              {error}
            </div>
          ) : null}

          <div className="flex flex-col gap-14px">
            <Label label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </Label>
            <Label label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Label>
            <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!username || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </div>
        </Card>
      </form>
    </div>
  );
}
