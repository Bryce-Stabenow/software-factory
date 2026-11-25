import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { executionConfigSchema, localProjectSettingsSchema, repositoryConfigurationSchema, type ExecutionConfig, type Project, type RepositoryConfiguration, type RepositoryConfigurationState } from '../../../../packages/contracts/src/index.js';
import { digest, fail } from '../workflows/engine.js';
import { git } from '../git/workspaces.js';

export const configurationFilename = '.kulumin.yml';
const maximumBytes = 64 * 1024;
export const verificationCommands = (config: RepositoryConfiguration): ExecutionConfig['validationCommands'] => config.verification.commands.map(command => ({ name: command.name, argv: command.run, timeoutMs: Math.round(command.timeout_seconds * 1000) }));
export const initializationCommands = (config: RepositoryConfiguration) => config.worktree_init.commands.map(command => ({ name: command.name, argv: command.run, timeoutMs: Math.round(command.timeout_seconds * 1000) }));
export function parseRepositoryConfiguration(text: string): RepositoryConfiguration {
  if (Buffer.byteLength(text) > maximumBytes) fail('INVALID_INPUT', '.kulumin.yml exceeds the 64 KiB limit.');
  try {
    const document = parseDocument(text, { uniqueKeys: true, strict: true });
    if (document.errors.length || document.warnings.length) throw new Error();
    return repositoryConfigurationSchema.parse(document.toJS({ maxAliasCount: 0 }));
  } catch { fail('INVALID_INPUT', 'Invalid .kulumin.yml. Use version: 1, worktree_init and verification sections with named run argument arrays and bounded timeout_seconds. Duplicate keys, aliases, unknown fields and tags are not supported.'); }
}
function readText(root: string): string | null {
  if (realpathSync(root) !== root) fail('WORKSPACE_CONFLICT', 'The repository directory changed. Reconnect its canonical location.');
  const path = join(root, configurationFilename);
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; fail('INVALID_INPUT', '.kulumin.yml must be a readable regular file, not a symlink.'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximumBytes) fail('INVALID_INPUT', '.kulumin.yml must be a regular file no larger than 64 KiB.');
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytes = 0, count: number;
    while (bytes < buffer.length && (count = readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += count;
    const text = buffer.subarray(0, bytes).toString('utf8');
    if (bytes > maximumBytes || Buffer.byteLength(text) > maximumBytes) fail('INVALID_INPUT', '.kulumin.yml exceeds the 64 KiB limit.');
    return text;
  } finally { closeSync(fd); }
}
export function readRepositoryConfiguration(root: string) {
  const text = readText(root);
  return text === null ? null : { text, digest: digest(text), configuration: parseRepositoryConfiguration(text) };
}
export function committedConfigurationMatches(root: string, ref: string, fileDigest: string): boolean {
  try {
    const entry = git(root, ['ls-tree', ref, '--', configurationFilename]);
    if (!/^100(?:644|755) blob /.test(entry)) return false;
    return digest(git(root, ['show', `${ref}:${configurationFilename}`], maximumBytes)) === fileDigest;
  } catch { return false; }
}
export function repositoryConfigurationState(project: Project): RepositoryConfigurationState {
  const stored = JSON.parse(project.config_json);
  const local = localProjectSettingsSchema.parse({ executionEnabled: false, trustedRepository: false, initializationNetworkAllowed: false, ...stored });
  const state: RepositoryConfigurationState = { path: join(project.repo_path, configurationFilename), exists: false, digest: null, configuration: null, committed: false, error: null, authorized: false, local, legacyVerification: stored.validationCommands ?? [] };
  try {
    const text = readText(project.repo_path);
    if (text === null) return state;
    state.exists = true; state.digest = digest(text);
    state.configuration = parseRepositoryConfiguration(text);
    state.authorized = stored.repositoryConfigDigest === digest(state.configuration);
    state.committed = committedConfigurationMatches(project.repo_path, `refs/heads/${project.default_branch}`, state.digest);
  } catch (error) { state.error = (error as Error).message; }
  return state;
}
function writeText(root: string, expected: string | null, text: string | null) {
  const current = readText(root);
  if ((current === null ? null : digest(current)) !== expected) fail('CONFLICT', '.kulumin.yml changed on disk. Reload project settings before saving.');
  const path = join(root, configurationFilename);
  if (text === null) { if (current !== null) unlinkSync(path); return; }
  const temporary = join(root, `.kulumin-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, current === null ? 0o644 : lstatSync(path).mode & 0o777);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    const latest = readText(root);
    if ((latest === null ? null : digest(latest)) !== expected) fail('CONFLICT', '.kulumin.yml changed on disk. Reload project settings before saving.');
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function writeRepositoryConfiguration(root: string, expected: string | null, configuration: RepositoryConfiguration) {
  const parsed = repositoryConfigurationSchema.parse(configuration), previous = readText(root);
  let text: string;
  if (previous !== null && digest(parseRepositoryConfiguration(previous)) === digest(parsed)) text = previous;
  else {
    // Preserve document-level comments while replacing the editable sections.
    const doc = previous === null ? parseDocument('') : parseDocument(previous);
    if (previous !== null) parseRepositoryConfiguration(previous);
    doc.set('version', parsed.version); doc.set('worktree_init', parsed.worktree_init); doc.set('verification', parsed.verification);
    text = doc.toString({ lineWidth: 0 });
  }
  if (Buffer.byteLength(text) > maximumBytes) fail('INVALID_INPUT', '.kulumin.yml exceeds the 64 KiB limit.');
  writeText(root, expected, text);
  return { digest: digest(text), rollback() { writeText(root, digest(text), previous); } };
}
export type ResolvedExecutionConfig = ExecutionConfig & { repositoryDigest?: string; initializationDigest?: string; initializationCommands: ExecutionConfig['validationCommands']; initializationNetwork: boolean };
export function resolveExecutionConfiguration(project: Project, root = project.repo_path): ResolvedExecutionConfig {
  const stored = JSON.parse(project.config_json);
  const local = executionConfigSchema.parse({ executionEnabled: false, trustedRepository: false, validationCommands: [], ...stored });
  const file = readRepositoryConfiguration(root);
  if (!file) {
    if (stored.repositoryConfigDigest) fail('POLICY_DENIED', 'The task worktree has no .kulumin.yml. Commit the configuration on the default branch before creating a new task worktree.');
    return { ...local, initializationCommands: [], initializationNetwork: false };
  }
  if (stored.repositoryConfigDigest !== digest(file.configuration)) fail('POLICY_DENIED', '.kulumin.yml changed or has not been approved on this device. Review and save it in Project settings before execution.');
  const ref = root === project.repo_path ? `refs/heads/${project.default_branch}` : 'HEAD';
  if (!committedConfigurationMatches(root, ref, file.digest)) fail('POLICY_DENIED', 'Commit .kulumin.yml on the project’s default branch before creating a task worktree. Uncommitted configuration cannot authorize execution.');
  if (file.configuration.worktree_init.network && !stored.initializationNetworkAllowed && file.configuration.worktree_init.commands.length) fail('POLICY_DENIED', 'Initialization requests network access. Allow it locally in Project settings before executing these commands.');
  return { ...local, validationCommands: verificationCommands(file.configuration), repositoryDigest: file.digest, initializationDigest: digest(file.configuration.worktree_init), initializationCommands: initializationCommands(file.configuration), initializationNetwork: file.configuration.worktree_init.network };
}
export function verificationDigest(config: ResolvedExecutionConfig) { return config.repositoryDigest ? digest({ commands: config.validationCommands, repositoryDigest: config.repositoryDigest }) : digest(config.validationCommands); }
