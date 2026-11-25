import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: 'inherit', ...options });

async function main() {
  if (process.platform !== 'darwin') throw new Error(`Desktop packaging currently supports macOS only; ${process.platform} is not supported yet.`);
  const configuration = JSON.parse(readFileSync(join(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  if (configuration.identifier !== 'local.kulumin.factory') throw new Error('The app identifier changed. Refusing an update that could select a different data directory.');
  const dataDir = resolve(process.env.FACTORY_DATA_DIR || join(homedir(), 'Library/Application Support', configuration.identifier));
  const targetApp = join(resolve(process.env.KULUMIN_APPLICATIONS_DIR || '/Applications'), 'Kulumin.app');
  const backupRoot = join(homedir(), 'Library/Application Support/Kulumin/updates');
  console.log(`Building Kulumin for macOS ${process.arch}.\nInstall: ${targetApp}\nExisting data: ${dataDir}`);
  run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
  const { installDesktopUpdate, assertIdle } = await import('./desktop-update.mjs');
  assertIdle(dataDir);
  // Ensure native crates for this machine are available before the offline release build.
  const host = execFileSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error('Could not detect the Rust host target. Install the Rust toolchain and Xcode command-line tools.');
  run('cargo', ['fetch', '--locked', '--target', host, '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml']);
  run('npm', ['run', 'package:desktop']);
  run('npm', ['run', 'test:package']);
  const { acquireRuntimeLock } = await import('../dist/apps/factory-service/src/persistence/runtime-lock.js');
  const result = await installDesktopUpdate({
    sourceApp: join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Kulumin.app'), targetApp, dataDir, backupRoot,
    copyApp: (source, destination) => run('/usr/bin/ditto', [source, destination]),
    verifyApp: path => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', path]),
    quitApp: () => {
      assertIdle(dataDir);
      run('/usr/bin/osascript', ['-e', 'if application id "local.kulumin.factory" is running then tell application id "local.kulumin.factory" to quit']);
    },
    acquireLock: async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      let lastError;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { return acquireRuntimeLock(dataDir); }
        catch (error) { lastError = error; await delay(100); }
      }
      throw new Error(`Kulumin did not release its data lock. No app was replaced. ${lastError.message}`);
    },
    launchApp: path => {
      const args = ['-n', path, '--env', `FACTORY_DATA_DIR=${dataDir}`];
      if (process.env.FACTORY_WORKSPACE_ROOT) args.push('--env', `FACTORY_WORKSPACE_ROOT=${resolve(process.env.FACTORY_WORKSPACE_ROOT)}`);
      run('/usr/bin/open', args);
    },
  });
  console.log(`\nUpdated and launched ${result.targetApp}\nPreserved data: ${result.dataDir}\nPrevious app and data backup: ${result.backupDir}`);
}
main().catch(error => { console.error(`\nRebuild failed: ${error.message}`); process.exitCode = 1; });
