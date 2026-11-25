import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ExecutionConfig } from '../../../../packages/contracts/src/index.js';
import { connectPlanningRpc, serverArgs } from '../agents/codex.js';
import { CodexError } from '../agents/rpc.js';
import { redact } from '../agents/snapshot.js';

export interface ValidationInput {
  cwd: string; temporaryDirectory: string; command: ExecutionConfig['validationCommands'][number];
  processId: string; signal: AbortSignal; onProcess: (pid: number) => void; onOutput: (log: string) => void;
}
export interface ValidationAdapter { run(input: ValidationInput): Promise<{ exitCode: number; log: string }> }
export const redactLog = (value: string) => redact(value)
  .replace(/(\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
  .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]');

export class CodexValidationRunner implements ValidationAdapter {
  constructor(private binary = process.env.FACTORY_CODEX_BINARY ?? 'codex', private args = serverArgs) {}
  async run(input: ValidationInput) {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.command.timeoutMs + 3000)]);
    const { rpc } = await connectPlanningRpc(this.binary, this.args, input.cwd, signal, input.onProcess);
    const streams = { stdout: { text: '', decoder: new StringDecoder('utf8') }, stderr: { text: '', decoder: new StringDecoder('utf8') } };
    let truncated = false, policyDenied = false;
    const render = (final: boolean) => Object.entries(streams).map(([name, stream]) => {
      const end = final ? stream.text.length : stream.text.lastIndexOf('\n') + 1;
      return end ? `[${name}]\n${redactLog(stream.text.slice(0, end))}` : '';
    }).filter(Boolean).join('\n') + (truncated ? '\n[output truncated]\n' : '');
    const capture = (name: 'stdout' | 'stderr', value: string, final = false) => {
      const stream = streams[name];
      if (stream.text.length + value.length > 64000) truncated = true;
      stream.text += value.slice(0, Math.max(0, 64000 - stream.text.length));
      // Withhold incomplete lines so credentials split across chunks are never
      // published as separate partial values. Redact the full captured text.
      const safe = render(final); if (safe) input.onOutput(safe);
    };
    rpc.on('message', frame => {
      if (frame.id !== undefined) {
        policyDenied = true; rpc.send({ id: frame.id, error: { code: -32601, message: 'Validation cannot grant additional permissions.' } }); void rpc.stop(); return;
      }
      if (frame.method === 'command/exec/outputDelta' && frame.params?.processId === input.processId && typeof frame.params.deltaBase64 === 'string') {
        const name = frame.params.stream === 'stderr' ? 'stderr' : 'stdout';
        capture(name, streams[name].decoder.write(Buffer.from(frame.params.deltaBase64, 'base64')));
        truncated ||= frame.params.capReached === true;
      }
    });
    const abort = () => { void rpc.request('command/exec/terminate', { processId: input.processId }, 500).catch(() => {}).finally(() => rpc.stop()); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const home = join(input.temporaryDirectory, 'home');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const result = await rpc.request('command/exec', {
        command: input.command.argv, cwd: input.cwd, processId: input.processId,
        timeoutMs: input.command.timeoutMs, outputBytesCap: 64000, streamStdoutStderr: true,
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [input.cwd, input.temporaryDirectory], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: input.temporaryDirectory, CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_CACHE: join(input.temporaryDirectory, 'npm-cache') },
      }, input.command.timeoutMs + 4000);
      signal.throwIfAborted();
      if (!Number.isInteger(result?.exitCode)) throw new CodexError('VALIDATION_FAILED', 'Validation returned no verified exit code.');
      capture('stdout', streams.stdout.decoder.end() + (result.stdout ?? ''), true);
      capture('stderr', streams.stderr.decoder.end() + (result.stderr ?? ''), true);
      return { exitCode: result.exitCode, log: render(true) };
    } catch (error) {
      capture('stdout', streams.stdout.decoder.end(), true); capture('stderr', streams.stderr.decoder.end(), true);
      if (signal.aborted) throw new CodexError(input.signal.aborted ? 'CANCELLED' : 'VALIDATION_TIMEOUT', input.signal.aborted ? 'Validation was cancelled.' : 'Validation exceeded its configured timeout.');
      if (policyDenied) throw new CodexError('POLICY_DENIED', 'Validation requested unsupported permissions; no expansion was granted.');
      throw error;
    } finally { signal.removeEventListener('abort', abort); await rpc.stop(); }
  }
}
