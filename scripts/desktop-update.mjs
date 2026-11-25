import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export function assertIdle(dataDir) {
  const path = join(dataDir, 'factory.db');
  if (!existsSync(path)) return;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const active = db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('queued','starting','running','waiting_permission','stopping')").get().n;
    if (active) throw new Error('Kulumin has active or queued work. Finish or stop it in the app, then run make rebuild again.');
  } finally { db.close(); }
}

async function backupData(dataDir, destination) {
  if (!existsSync(dataDir)) return;
  const excluded = new Set(['service.lock', 'service-owner.db', 'service-owner.db-wal', 'service-owner.db-shm', 'service-owner.db-journal', 'factory.db', 'factory.db-wal', 'factory.db-shm', 'factory.db-journal']);
  cpSync(dataDir, destination, { recursive: true, verbatimSymlinks: true, filter: path => dirname(path) !== dataDir || !excluded.has(basename(path)) });
  const database = join(dataDir, 'factory.db');
  if (existsSync(database)) {
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try { await db.backup(join(destination, 'factory.db')); }
    finally { db.close(); }
    const backup = new Database(join(destination, 'factory.db'), { fileMustExist: true });
    try { backup.pragma('journal_mode = DELETE'); if (backup.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('The data backup failed its SQLite integrity check.'); }
    finally { backup.close(); }
  }
}

const contains = (parent, child) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('../') && !isAbsolute(path); };

// Only the app bundle is replaced. The live data directory is never replaced or restored.
export async function installDesktopUpdate({ sourceApp, targetApp, dataDir, backupRoot, copyApp, verifyApp, quitApp, acquireLock, launchApp }) {
  [sourceApp, targetApp, dataDir, backupRoot] = [sourceApp, targetApp, dataDir, backupRoot].map(path => resolve(path));
  for (const [a, b] of [[sourceApp, targetApp], [sourceApp, dataDir], [sourceApp, backupRoot], [targetApp, dataDir], [backupRoot, dataDir], [targetApp, backupRoot]]) {
    if (contains(a, b) || contains(b, a)) throw new Error('Application, data, build, and backup paths must be separate.');
  }
  if (!existsSync(sourceApp)) throw new Error('The built Kulumin.app is missing.');
  if (existsSync(targetApp) && (lstatSync(targetApp).isSymbolicLink() || !lstatSync(targetApp).isDirectory())) throw new Error('The installed app path must be a directory, not a symlink or file.');
  mkdirSync(dirname(targetApp), { recursive: true });
  accessSync(dirname(targetApp), constants.W_OK);
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const backupDir = join(backupRoot, id);
  const stagedApp = join(dirname(targetApp), `.Kulumin-update-${id}.app`);
  const previousApp = join(dirname(targetApp), `.Kulumin-previous-${id}.app`);
  let release, movedPrevious = false, installed = false;
  try {
    await copyApp(sourceApp, stagedApp);
    await verifyApp(stagedApp);
    assertIdle(dataDir);
    await quitApp();
    release = await acquireLock();
    assertIdle(dataDir);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    if (existsSync(targetApp)) await copyApp(targetApp, join(backupDir, 'Kulumin.app'));
    await backupData(dataDir, join(backupDir, 'data'));
    if (existsSync(targetApp)) { renameSync(targetApp, previousApp); movedPrevious = true; }
    try {
      renameSync(stagedApp, targetApp); installed = true;
      await verifyApp(targetApp);
    } catch (error) {
      if (installed) { rmSync(targetApp, { recursive: true, force: true }); installed = false; }
      if (movedPrevious) { renameSync(previousApp, targetApp); movedPrevious = false; }
      throw error;
    }
    if (movedPrevious) { rmSync(previousApp, { recursive: true }); movedPrevious = false; }
  } finally {
    if (release) release();
    rmSync(stagedApp, { recursive: true, force: true });
  }
  // A new version can migrate its database on startup. Never downgrade the app or
  // restore an older database automatically after launch has been attempted.
  try { await launchApp(targetApp); }
  catch (error) { throw new Error(`The update is installed, but launch failed: ${error.message}. Open ${targetApp} manually. Backup: ${backupDir}`); }
  return { targetApp, dataDir, backupDir };
}
