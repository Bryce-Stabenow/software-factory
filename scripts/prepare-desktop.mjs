import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Desktop packaging currently supports macOS on the build machine architecture.');
const output = join(root, 'apps/desktop/src-tauri/resources/companion');
// This directory is generated exclusively by this script and is never a data directory.
rmSync(output, { recursive: true, force: true }); mkdirSync(join(output, 'runtime'), { recursive: true });
writeFileSync(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module', version: '0.1.0' }));
cpSync(join(root, 'dist/apps/factory-service'), join(output, 'dist/apps/factory-service'), { recursive: true });
mkdirSync(join(output, 'dist/scripts'), { recursive: true });
copyFileSync(join(root, 'dist/scripts/restore-backup.js'), join(output, 'dist/scripts/restore-backup.js'));
cpSync(join(root, 'dist/packages/contracts'), join(output, 'dist/packages/contracts'), { recursive: true });
for (const name of ['zod', 'bindings', 'file-uri-to-path']) cpSync(realpathSync(join(root, 'node_modules', name)), join(output, 'node_modules', name), { recursive: true, dereference: true });
const sqlite = join(root, 'node_modules/better-sqlite3'), target = join(output, 'node_modules/better-sqlite3');
mkdirSync(join(target, 'build/Release'), { recursive: true });
for (const name of ['package.json', 'LICENSE']) copyFileSync(join(sqlite, name), join(target, name));
cpSync(join(sqlite, 'lib'), join(target, 'lib'), { recursive: true });
const addon = join(target, 'build/Release/better_sqlite3.node'); copyFileSync(join(sqlite, 'build/Release/better_sqlite3.node'), addon);
const node = join(output, 'runtime/node'); copyFileSync(realpathSync(process.execPath), node); chmodSync(node, 0o755);
copyFileSync(join(dirname(dirname(realpathSync(process.execPath))), 'LICENSE'), join(output, 'runtime/NODE-LICENSE'));
for (const binary of [node, addon]) {
  const linked = execFileSync('/usr/bin/otool', ['-L', binary], { encoding: 'utf8' });
  if (linked.split('\n').slice(1).some(line => line.trim() && !/^\s*(\/usr\/lib\/|\/System\/Library\/)/.test(line))) throw new Error('The selected Node/addon links non-system libraries. Use a standalone official Node installation.');
}
const identity = process.env.APPLE_SIGNING_IDENTITY ?? '-';
execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--options','runtime']), addon], { stdio: 'inherit' });
execFileSync('/usr/bin/codesign', ['--force', '--sign', identity, '--entitlements', join(root, 'apps/desktop/src-tauri/node.entitlements.plist'), ...(identity === '-' ? [] : ['--options','runtime']), node], { stdio: 'inherit' });
const inventory = [];
function walk(path, prefix = '') { for (const entry of readdirSync(path, { withFileTypes: true })) { const name = prefix + entry.name; if (entry.isDirectory()) walk(join(path, entry.name), name + '/'); else if (entry.isFile()) inventory.push({ path: name, sha256: createHash('sha256').update(readFileSync(join(path, entry.name))).digest('hex') }); else throw new Error('Unexpected resource type.'); } }
walk(output);
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ formatVersion: 1, platform: process.platform, arch: process.arch, node: process.versions.node, nodeAbi: process.versions.modules, files: inventory }, null, 2));
// Prove this runtime can load the bundled native addon without repository dependencies.
execFileSync(node, ['--input-type=module', '-e', "import Database from 'better-sqlite3';import {z} from 'zod';const d=new Database(':memory:');z.number().parse(d.prepare('SELECT 1 AS n').get().n);d.close();"], { cwd: output, env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME }, stdio: 'inherit' });
console.log(`Prepared self-contained Node ${process.versions.node} companion (${process.arch}); ${inventory.length} verified resources.`);
