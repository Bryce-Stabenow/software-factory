import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { allowedPath, redact } from '../agents/snapshot.js';
import { CodexError } from '../agents/rpc.js';
import { git } from './workspaces.js';

const writeSchema = z.object({ path: z.string().min(1).max(500), content: z.string().max(1024 * 1024), expectedDigest: z.string().length(64).nullable() });
const deleteSchema = z.object({ path: z.string().min(1).max(500), expectedDigest: z.string().length(64) });
const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
export const implementationTools = [
  { type: 'function', name: 'list_repository_files', description: 'List readable text-file candidates in this task Git worktree.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'read_repository_file', description: 'Read a worktree text file and its SHA-256 digest. Read before replacing or deleting an existing file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { type: 'function', name: 'write_repository_file', description: 'Create or replace a text file within this task worktree only. expectedDigest is null for a new file, or the digest returned by reading the existing file. No shell or Git metadata edits.', inputSchema: z.toJSONSchema(writeSchema) },
  { type: 'function', name: 'delete_repository_file', description: 'Delete one previously read text file in this task worktree, if its digest still matches. No directory or Git metadata deletion.', inputSchema: z.toJSONSchema(deleteSchema) },
];

export class WorkspaceFiles {
  private calls = 0;
  private bytesWritten = 0;
  private written = new Set<string>();
  private root: string;
  constructor(path: string, private guard: () => void) { this.root = realpathSync(path); }
  touched() { return [...this.written].sort(); }
  private files() {
    const names = git(this.root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    return [...new Set([...names, ...this.written])].filter(name => this.permitted(name)).sort().slice(0, 3000);
  }
  private permitted(path: string) { return allowedPath(path) && !/(^|\/)(\.gitattributes|\.gitmodules)$/.test(path) && !path.includes('\\') && !path.startsWith('-') && !path.includes('\0'); }
  private target(name: string) {
    if (!this.permitted(name)) throw new CodexError('POLICY_DENIED', 'This path is outside the allowed implementation file scope.');
    const path = join(this.root, name), rel = relative(this.root, path);
    if (!rel || rel.startsWith('..' + sep) || rel === '..') throw new CodexError('POLICY_DENIED', 'Worktree path escape denied.');
    let cursor = this.root;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || realpathSync(cursor) !== cursor)) throw new CodexError('POLICY_DENIED', 'Symlinked implementation paths are not supported.');
    }
    return path;
  }
  private current(name: string) {
    const path = this.target(name);
    if (!existsSync(path)) return null;
    if (!this.files().includes(name)) throw new CodexError('POLICY_DENIED', 'Ignored files cannot be inspected or replaced.');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new CodexError('POLICY_DENIED', 'Implementation tools support regular text files up to 1 MiB.');
    const content = readFileSync(path);
    if (content.includes(0)) throw new CodexError('POLICY_DENIED', 'Binary file edits are not enabled.');
    return { digest: hash(content), content: redact(content.toString('utf8')) };
  }
  call(tool: string, input: unknown): string {
    this.guard();
    if (++this.calls > 500) throw new CodexError('TOOL_LIMIT', 'Implementation exceeded 500 file-tool calls.');
    if (tool === 'list_repository_files') return JSON.stringify(this.files());
    if (tool === 'read_repository_file') {
      const { path } = z.object({ path: z.string().min(1) }).parse(input);
      const file = this.current(path);
      if (!file) throw new CodexError('NOT_FOUND', 'The requested worktree file does not exist.');
      return JSON.stringify({ path, ...file });
    }
    if (tool === 'write_repository_file') {
      const value = writeSchema.parse(input);
      const path = this.target(value.path), before = this.current(value.path);
      if ((before?.digest ?? null) !== value.expectedDigest) throw new CodexError('WORKSPACE_CONFLICT', 'File digest changed. Read the current file before trying again.');
      this.bytesWritten += Buffer.byteLength(value.content);
      if (this.bytesWritten > 10 * 1024 * 1024 || this.written.size >= 200 && !this.written.has(value.path)) throw new CodexError('TOOL_LIMIT', 'Implementation exceeded its file-write budget.');
      this.guard();
      mkdirSync(dirname(path), { recursive: true });
      this.target(value.path);
      const temporary = join(dirname(path), `.kulumin-${randomUUID()}.tmp`);
      try { writeFileSync(temporary, value.content, { flag: 'wx', mode: existsSync(path) ? lstatSync(path).mode & 0o777 : 0o644 }); renameSync(temporary, path); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      this.written.add(value.path);
      return JSON.stringify({ path: value.path, digest: hash(value.content), written: true });
    }
    if (tool === 'delete_repository_file') {
      const value = deleteSchema.parse(input), before = this.current(value.path);
      if (!before || before.digest !== value.expectedDigest) throw new CodexError('WORKSPACE_CONFLICT', 'File digest changed or the file is missing.');
      this.guard(); unlinkSync(this.target(value.path)); this.written.add(value.path);
      return JSON.stringify({ path: value.path, deleted: true });
    }
    throw new CodexError('POLICY_DENIED', 'Only task-worktree file tools are permitted.');
  }
}
