import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type ExchangeDirStats = {
  name: string;
  path: string;
  exists: boolean;
  fileCount: number;
  newestMtimeMs: number | null;
  sampleNames: string[];
};

/**
 * Phase 9: read-only view of air-gapped exchange directories.
 */
export class ExchangeService {
  constructor(private readonly enclaveRoot: string) {}

  snapshot(): { dirs: ExchangeDirStats[]; projectedAt: string } {
    const base = join(this.enclaveRoot, 'exchange');
    const names = [
      'requests',
      'inbox',
      'raw',
      'normalized',
      'briefs-pending',
      'briefs',
      'briefs-flagged',
      'ledger',
      'reviews',
    ];
    const dirs = names.map((name) => statsFor(join(base, name), name));
    return { dirs, projectedAt: new Date().toISOString() };
  }
}

function statsFor(path: string, name: string): ExchangeDirStats {
  if (!existsSync(path)) {
    return {
      name,
      path,
      exists: false,
      fileCount: 0,
      newestMtimeMs: null,
      sampleNames: [],
    };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(path).filter((f) => !f.startsWith('.'));
  } catch {
    entries = [];
  }
  let newest: number | null = null;
  const files: string[] = [];
  for (const ent of entries) {
    try {
      const st = statSync(join(path, ent));
      if (st.isFile()) {
        files.push(ent);
        newest = newest == null ? st.mtimeMs : Math.max(newest, st.mtimeMs);
      } else if (st.isDirectory() && ent === 'archive') {
        // count archive dir as one sample
        files.push(`${ent}/`);
      }
    } catch {
      /* skip */
    }
  }
  files.sort();
  return {
    name,
    path,
    exists: true,
    fileCount: files.length,
    newestMtimeMs: newest,
    sampleNames: files.slice(0, 12),
  };
}
