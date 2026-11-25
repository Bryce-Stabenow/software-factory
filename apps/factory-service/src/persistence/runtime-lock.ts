import Database from 'better-sqlite3';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A separate SQLite connection holds an OS-backed exclusive lock for the service
// lifetime. The OS releases it on a crash; PID files are diagnostic/legacy guards.
export function acquireRuntimeLock(directory: string) {
  const path = join(directory, 'service.lock');
  const owner = new Database(join(directory, 'service-owner.db'), { timeout: 0 });
  const close = () => { try { if (owner.inTransaction) owner.exec('ROLLBACK'); } finally { owner.close(); } };
  try {
    owner.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO owner_lock VALUES (1);');
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid legacy service lock; inspect it before removing it.');
      try { process.kill(pid, 0); throw new Error('A factory service is already using this data directory.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    writeFileSync(path, String(process.pid), { mode: 0o600 });
  } catch (error) {
    close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY' || (error as { code?: string }).code === 'SQLITE_LOCKED') throw new Error('A factory service is already using this data directory.');
    throw error;
  }
  let released = false;
  return () => { if (released) return; released = true; try { unlinkSync(path); } finally { close(); } };
}
