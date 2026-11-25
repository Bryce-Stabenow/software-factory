import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexError } from './rpc.js';

const denied = /(^|\/)(\.git|\.factory|node_modules|target|dist|\.ssh|\.aws|\.codex|\.agents|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|secrets?(?:\..*)?)(\/|$)|\.(pem|key|p12|pfx|db|sqlite|sqlite3)$/i;
export const redact = (text: string) => text.replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{15,}|eyJ[a-zA-Z0-9_-]{15,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, '[REDACTED]').replace(/(\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
export function allowedPath(path: string) { return !isAbsolute(path) && !path.split(/[\\/]/).includes('..') && !denied.test(path.replaceAll('\\', '/')); }
export function snapshotDigest(root: string, files: string[]) {
  const inventory: string[] = [];
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new CodexError('POLICY_DENIED', 'A symlink appeared in the planning snapshot.');
      if (entry.isDirectory()) walk(join(directory, entry.name), name + '/');
      else if (entry.isFile()) inventory.push(name);
      else throw new CodexError('POLICY_DENIED', 'An unexpected artifact appeared in the planning snapshot.');
    }
  };
  walk(root);
  if (JSON.stringify(inventory.sort()) !== JSON.stringify([...files].sort())) throw new CodexError('POLICY_DENIED', 'The planning snapshot file inventory changed.');
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file + '\0'); hash.update(readFileSync(join(root, file))); }
  return hash.digest('hex');
}
export function createPlanningSnapshot(repo: string, path: string) {
  const root = realpathSync(repo);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  path = realpathSync(path);
  const names = execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 }).split('\0');
  const files: string[] = []; let size = 0, omitted = 0;
  for (const name of [...new Set(names)].filter(Boolean).sort()) {
    if (!allowedPath(name) || files.length >= 1000) { omitted++; continue; }
    const source = join(root, name);
    try {
      const resolved = realpathSync(source);
      // Reject symlinks anywhere along the path, even those pointing inside the repo.
      if (resolved !== source || relative(root, resolved).startsWith('..' + sep)) { omitted++; continue; }
      if (!lstatSync(source).isFile()) { omitted++; continue; }
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 256 * 1024 || size + stat.size > 20 * 1024 * 1024) { omitted++; continue; }
        const buffer = Buffer.alloc(256 * 1024 + 1);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        if (length > 256 * 1024 || size + length > 20 * 1024 * 1024) { omitted++; continue; }
        bytes = buffer.subarray(0, length);
      } finally { closeSync(fd); }
      if (bytes.includes(0)) { omitted++; continue; }
      const destination = join(path, name);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      writeFileSync(destination, redact(bytes.toString('utf8')), { mode: 0o400, flag: 'wx' });
      files.push(name); size += bytes.length;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error; omitted++; }
  }
  return { path, files, omitted, digest: snapshotDigest(path, files) };
}
export class SnapshotReader {
  private calls = 0;
  constructor(readonly path: string, readonly files: string[]) {}
  call(tool: string, args: unknown): string {
    if (++this.calls > 150) throw new CodexError('TOOL_LIMIT', 'Planning exceeded the repository-read limit.');
    if (tool === 'list_repository_files') return JSON.stringify(this.files);
    if (tool !== 'read_repository_file' || !args || typeof args !== 'object') throw new CodexError('POLICY_DENIED', 'Only snapshot list/read tools are permitted.');
    const file = (args as { path?: unknown }).path;
    if (typeof file !== 'string' || !allowedPath(file) || !this.files.includes(file)) throw new CodexError('POLICY_DENIED', 'Path is outside the planning snapshot or excluded.');
    const path = join(this.path, file);
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path || !realpathSync(path).startsWith(this.path + sep)) throw new CodexError('POLICY_DENIED', 'Snapshot path changed.');
    return readFileSync(path, 'utf8');
  }
}
