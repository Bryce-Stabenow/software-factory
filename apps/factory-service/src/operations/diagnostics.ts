import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostics, ProviderHealth, StoredExport } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../persistence/store.js';

export class Operations {
  private pending = new Set<Promise<StoredExport>>();
  private closing = false;
  constructor(private store: Store, readonly dataDir: string) {}
  diagnostics(provider: ProviderHealth): Diagnostics {
    const db = this.store.db, bytes = (path: string) => { try { return statSync(path).size; } catch { return 0; } };
    const group = (table: 'tasks' | 'agent_runs') => Object.fromEntries((db.prepare(`SELECT status,COUNT(*) AS n FROM ${table} GROUP BY status`).all() as { status: string; n: number }[]).map(row => [row.status, row.n]));
    let availableBytes: number | null = null;
    try { const fs = statfsSync(this.dataDir); availableBytes = fs.bavail * fs.bsize; } catch { /* Storage metrics may not be available on every filesystem. */ }
    const integrity = (db.pragma('quick_check(1)') as Record<string, string>[])[0]?.quick_check === 'ok' ? 'ok' : 'needs_attention';
    const stale = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('starting','running','waiting_permission','stopping') AND (heartbeat_at IS NULL OR heartbeat_at < ?)").get(new Date(Date.now() - 30000).toISOString()) as { n: number };
    const errors = db.prepare('SELECT stage,error_code AS code,COUNT(*) AS count FROM (SELECT stage,error_code FROM agent_runs WHERE error_code IS NOT NULL ORDER BY rowid DESC LIMIT 100) GROUP BY stage,error_code').all() as { stage: string; code: string; count: number }[];
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      formatVersion: 1, generatedAt: new Date().toISOString(),
      application: { version: '0.1.0', packaged: process.env.FACTORY_PACKAGED === '1', platform: process.platform, arch: process.arch, node: process.versions.node, nodeAbi: process.versions.modules, uptimeSeconds: Math.floor(process.uptime()) },
      storage: { schemaVersion: (db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get() as { n: number }).n, integrity, databaseBytes: bytes(join(this.dataDir, 'factory.db')), walBytes: bytes(join(this.dataDir, 'factory.db-wal')), availableBytes },
      counts: { projects: count('SELECT COUNT(*) AS n FROM projects'), openRequests: count("SELECT COUNT(*) AS n FROM requests WHERE status='open'"), archivedRequests: count("SELECT COUNT(*) AS n FROM requests WHERE status='archived'"), tasks: group('tasks'), runs: group('agent_runs'), eventCursor: count('SELECT COALESCE(MAX(sequence),0) AS n FROM events'), staleHeartbeats: stale.n },
      provider: { checked: provider.available || provider.authenticated || provider.message !== 'Not checked. Check the local Codex CLI connection in Settings.', available: provider.available, authenticated: provider.authenticated },
      recentErrors: errors.map(error => ({ stage: /^(plan|implement|validate|review|repair)$/.test(error.stage) ? error.stage : 'other', code: /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'OTHER', count: error.count })),
      notices: [
        ...(integrity !== 'ok' ? ['Database integrity needs attention. Preserve a backup and stop workers before recovery.'] : []),
        ...(availableBytes !== null && availableBytes < 1024 ** 3 ? ['Less than 1 GiB of disk space is available.'] : []),
        ...(stale.n ? ['Some active workers have not updated their heartbeat for 30 seconds. Inspect activity before stopping or recovering them.'] : []),
        ...(!provider.available ? ['Codex connection has not been verified. Check the connection in Settings.'] : []),
      ],
    };
  }
  private destination(kind: 'diagnostics' | 'backup', extension: string) {
    const directory = join(this.dataDir, 'exports');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, `kulumin-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}.${extension}`);
  }
  private result(path: string): StoredExport {
    const bytes = readFileSync(path);
    return { path, filename: path.split(/[\\/]/).at(-1)!, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  exportDiagnostics(provider: ProviderHealth) {
    const path = this.destination('diagnostics', 'json');
    writeFileSync(path, JSON.stringify(this.diagnostics(provider), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return this.result(path);
  }
  backup(): Promise<StoredExport> {
    if (this.closing) return Promise.reject(new Error('Service is closing.'));
    const pending = this.makeBackup(); this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }
  async close() { this.closing = true; await Promise.allSettled([...this.pending]); }
  private async makeBackup() {
    const path = this.destination('backup', 'db');
    await this.store.db.backup(path);
    chmodSync(path, 0o600);
    return this.result(path);
  }
}
