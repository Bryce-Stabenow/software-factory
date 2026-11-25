import Database from 'better-sqlite3';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../apps/factory-service/src/persistence/store.js';
import { acquireRuntimeLock } from '../apps/factory-service/src/persistence/runtime-lock.js';

export async function restoreBackup(sourcePath: string, destinationPath: string) {
  const source = resolve(sourcePath), destination = resolve(destinationPath);
  if (!existsSync(source)) throw new Error('Choose an existing database backup.');
  if (existsSync(join(destination, 'factory.db'))) throw new Error('Restore requires a new data directory; existing databases are never overwritten.');
  const input = new Database(source, { readonly: true, fileMustExist: true });
  let release: (() => void) | undefined;
  try {
    if ((input.pragma('quick_check') as { quick_check: string }[]).some(row => row.quick_check !== 'ok') || (input.pragma('foreign_key_check') as unknown[]).length) throw new Error('Backup integrity checks failed.');
    const version = (input.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
    if (!version || version > 7) throw new Error('This backup requires a different version of Kulumin.');
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    release = acquireRuntimeLock(destination);
    // Recheck after taking ownership, including SQLite sidecars left by a partial restore.
    if (['factory.db','factory.db-wal','factory.db-shm'].some(name => existsSync(join(destination, name)))) throw new Error('The destination contains database state. Choose a new directory.');
    await input.backup(join(destination, 'factory.db'));
    const restored = new Store(join(destination, 'factory.db'));
    try { if ((restored.db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Restored database failed consistency checks.'); }
    finally { restored.close(); }
  } finally { input.close(); release?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2), source = args[args.indexOf('--backup') + 1], destination = args[args.indexOf('--data-dir') + 1];
  if (!args.includes('--backup') || !args.includes('--data-dir') || !source || !destination) throw new Error('Usage: npm run restore -- --backup FILE --data-dir NEW_DIRECTORY');
  await restoreBackup(source, destination);
  console.log('Backup restored and schema verified. Open Kulumin with the new data directory. Worktree references retain their original locations.');
}
