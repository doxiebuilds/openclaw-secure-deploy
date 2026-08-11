import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type SecurityCheckResult = {
  ok: boolean;
  tool: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary: string;
};

/**
 * Phase 8: surface enclave static checks and basic posture.
 */
export class SecurityService {
  constructor(private readonly monorepoRoot: string) {}

  async runEnclaveCheck(): Promise<SecurityCheckResult> {
    const script = join(this.monorepoRoot, 'tools/enclave-check/check.py');
    if (!existsSync(script)) {
      return {
        ok: false,
        tool: 'enclave-check',
        exitCode: null,
        stdout: '',
        stderr: `missing ${script}`,
        summary: 'enclave-check not found',
      };
    }
    return runPython(script, [], this.monorepoRoot, 'enclave-check');
  }

  async runApprovalsDrift(): Promise<SecurityCheckResult> {
    // Prefer in-container check-approvals.sh when main cell is up
    return new Promise((resolve) => {
      const child = spawn(
        'docker',
        ['exec', 'openclaw', 'sh', '/home/node/scripts/check-approvals.sh'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        stderr += c;
      });
      child.on('error', (err) => {
        resolve({
          ok: false,
          tool: 'check-approvals',
          exitCode: null,
          stdout: '',
          stderr: err.message,
          summary: 'failed to exec check-approvals',
        });
      });
      child.on('close', (code) => {
        const text = (stdout + '\n' + stderr).trim();
        const critical = /CRITICAL|DRIFT|FAIL/i.test(text);
        resolve({
          ok: code === 0 && !critical,
          tool: 'check-approvals',
          exitCode: code,
          stdout: stdout.slice(0, 20_000),
          stderr: stderr.slice(0, 8_000),
          summary: code === 0 ? (critical ? 'drift signals present' : 'ok') : `exit ${code}`,
        });
      });
    });
  }

  posture() {
    return {
      bindDefault: '127.0.0.1',
      connector: 'docker-exec',
      hostWsTokenOnlyScopes: false,
      notes: [
        'Control plane must not run inside agent cells.',
        'Host raw WebSocket token-only connect does not grant operator scopes (Phase 0).',
        'Config apply writes host RO-mounted openclaw.json; restart gateway after apply.',
        'Docker access on the API host is operator-equivalent trust.',
      ],
    };
  }
}

function runPython(
  script: string,
  args: string[],
  cwd: string,
  tool: string
): Promise<SecurityCheckResult> {
  return new Promise((resolve) => {
    const child = spawn('python3', [script, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      resolve({
        ok: false,
        tool,
        exitCode: null,
        stdout: '',
        stderr: err.message,
        summary: 'spawn failed',
      });
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        tool,
        exitCode: code,
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 10_000),
        summary: code === 0 ? 'PASS' : `exit ${code}`,
      });
    });
  });
}
