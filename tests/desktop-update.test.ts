import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { assertIdle, installDesktopUpdate } from '../scripts/desktop-update.mjs';

function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'kulumin-update-'));
  const sourceApp = join(root, 'build/Kulumin.app'), targetApp = join(root, 'Applications/Kulumin.app'), dataDir = join(root, 'persistent-data'), backupRoot = join(root, 'updates');
  for (const path of [sourceApp, targetApp, dataDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(sourceApp, 'version'), 'new'); writeFileSync(join(targetApp, 'version'), 'old');
  const db = new Database(join(dataDir, 'factory.db'));
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE agent_runs (status TEXT); CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('Keep my projects, tasks and approvals');");
  mkdirSync(join(dataDir, 'artifacts')); writeFileSync(join(dataDir, 'artifacts/log.txt'), 'Retained log');
  writeFileSync(join(dataDir, 'service.lock'), '123'); writeFileSync(join(dataDir, 'service-owner.db'), 'Do not back up a runtime ownership lock');
  const order: string[] = [];
  let released = false;
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const options = {
    sourceApp, targetApp, dataDir, backupRoot,
    copyApp: async (source: string, destination: string) => cpSync(source, destination, { recursive: true }),
    verifyApp: async (path: string) => { assert.equal(readFileSync(join(path, 'version'), 'utf8'), 'new'); order.push('verify'); },
    quitApp: async () => { order.push('quit'); },
    acquireLock: async () => { order.push('lock'); return () => { released = true; order.push('release'); }; },
    launchApp: async (path: string) => { assert.ok(released); assert.equal(path, targetApp); order.push('launch'); },
  };
  return { root, db, order, options };
}

test('desktop update retains live data, backs up WAL commits and artifacts, and replaces the app', async t => {
  const h = setup(t), result = await installDesktopUpdate(h.options);
  assert.equal(readFileSync(join(result.targetApp, 'version'), 'utf8'), 'new');
  assert.equal(readFileSync(join(result.backupDir, 'Kulumin.app/version'), 'utf8'), 'old');
  assert.equal(h.db.prepare('SELECT body FROM notes').get().body, 'Keep my projects, tasks and approvals');
  const backup = new Database(join(result.backupDir, 'data/factory.db'), { readonly: true });
  try { assert.deepEqual(backup.prepare('SELECT * FROM notes').all(), h.db.prepare('SELECT * FROM notes').all()); }
  finally { backup.close(); }
  assert.equal(readFileSync(join(result.backupDir, 'data/artifacts/log.txt'), 'utf8'), 'Retained log');
  for (const path of ['service.lock', 'service-owner.db', 'factory.db-wal', 'factory.db-shm']) assert.equal(existsSync(join(result.backupDir, 'data', path)), false);
  assert.deepEqual(h.order, ['verify', 'quit', 'lock', 'verify', 'release', 'launch']);
  assert.deepEqual(readdirSync(join(h.root, 'Applications')), ['Kulumin.app']);
});

test('desktop update refuses active work before quitting or replacing the app', async t => {
  const h = setup(t); h.db.prepare('INSERT INTO agent_runs VALUES (?)').run('running');
  assert.throws(() => assertIdle(h.options.dataDir), /active or queued/);
  await assert.rejects(installDesktopUpdate(h.options), /active or queued/);
  assert.deepEqual(h.order, ['verify']);
  assert.equal(readFileSync(join(h.options.targetApp, 'version'), 'utf8'), 'old');
  assert.deepEqual(readdirSync(join(h.root, 'Applications')), ['Kulumin.app']);
});

test('desktop update restores the previous app if installed signature verification fails', async t => {
  const h = setup(t);
  h.options.verifyApp = async path => { if (path === h.options.targetApp) throw new Error('Invalid installed signature'); };
  await assert.rejects(installDesktopUpdate(h.options), /Invalid installed signature/);
  assert.equal(readFileSync(join(h.options.targetApp, 'version'), 'utf8'), 'old');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 1);
  assert.deepEqual(h.order, ['quit', 'lock', 'release']);
  assert.deepEqual(readdirSync(join(h.root, 'Applications')), ['Kulumin.app']);
});

test('desktop update does not replace the app when another service owns the data lock', async t => {
  const h = setup(t); h.options.acquireLock = async () => { throw new Error('Data directory in use'); };
  await assert.rejects(installDesktopUpdate(h.options), /Data directory in use/);
  assert.equal(readFileSync(join(h.options.targetApp, 'version'), 'utf8'), 'old');
  assert.equal(existsSync(h.options.backupRoot), false);
  assert.deepEqual(readdirSync(join(h.root, 'Applications')), ['Kulumin.app']);
});

test('launch failure retains the new app and backup without downgrading potentially migrated data', async t => {
  const h = setup(t); h.options.launchApp = async () => { h.db.exec("INSERT INTO notes VALUES ('New version migration')"); throw new Error('Launch error'); };
  await assert.rejects(installDesktopUpdate(h.options), /update is installed, but launch failed/);
  assert.equal(readFileSync(join(h.options.targetApp, 'version'), 'utf8'), 'new');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 2);
  const backupDir = join(h.options.backupRoot, readdirSync(h.options.backupRoot)[0]);
  assert.equal(readFileSync(join(backupDir, 'Kulumin.app/version'), 'utf8'), 'old');
});

test('desktop update refuses overlapping app and data paths before touching either', async t => {
  const h = setup(t); h.options.backupRoot = join(h.options.dataDir, 'updates');
  await assert.rejects(installDesktopUpdate(h.options), /paths must be separate/);
  assert.deepEqual(h.order, []);
});
