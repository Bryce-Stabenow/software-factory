import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

// Provider-native objects stay inside this adapter boundary.
export type RpcMessage = Record<string, any>;
export class CodexError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'CODEX_HOME']) if (process.env[key]) env[key] = process.env[key];
  return env;
}
export class CodexRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = '';
  private ended = false;
  private closed = false;
  private stopping?: Promise<void>;
  constructor(binary: string, args: string[], cwd: string) {
    super();
    this.child = spawn(binary, args, { cwd, env: childEnvironment(), stdio: 'pipe', detached: process.platform !== 'win32' });
    this.child.stderr.resume(); // Never forward auth details or raw provider diagnostics.
    this.child.stdout.setEncoding('utf8');
    this.child.stdin.on('error', () => this.finish(new CodexError('PROVIDER_DISCONNECTED', 'Codex app-server disconnected.')));
    this.child.on('error', () => this.finish(new CodexError('PROVIDER_UNAVAILABLE', 'Codex could not start. Install Codex CLI and ensure it is on PATH.')));
    this.child.on('close', () => { this.closed = true; this.finish(new CodexError('PROVIDER_DISCONNECTED', 'Codex stopped before completing the request.')); });
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) { this.finish(new CodexError('PROTOCOL_ERROR', 'Codex response exceeded the size limit.')); void this.stop(); return; }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as RpcMessage;
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
          if (typeof frame.method === 'string') this.emit('message', frame);
          else {
            const call = this.pending.get(frame.id);
            if (!call) continue;
            clearTimeout(call.timer); this.pending.delete(frame.id);
            if (frame.error) call.reject(new CodexError('PROVIDER_ERROR', 'Codex rejected the request. Check CLI authentication, model access, and protocol compatibility.'));
            else call.resolve(frame.result);
          }
        } catch { this.finish(new CodexError('PROTOCOL_ERROR', 'Invalid Codex app-server protocol message.')); void this.stop(); }
      }
    });
  }
  private finish(error: Error) {
    if (this.ended) return;
    this.ended = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.emit('closed', error);
  }
  send(frame: RpcMessage) { if (!this.ended) this.child.stdin.write(JSON.stringify(frame) + '\n'); }
  request(method: string, params: unknown, timeoutMs = 15000): Promise<any> {
    if (this.ended) return Promise.reject(new CodexError('PROVIDER_DISCONNECTED', 'Codex is disconnected.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CodexError('PROVIDER_TIMEOUT', `Codex did not respond to ${method} in time.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'kulumin_factory', title: 'Kulumin', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} }); return result;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.child.stdin.end();
      if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, 'SIGKILL'); else this.child.kill('SIGKILL'); } catch { /* Already stopped. */ }
        }, 500);
        this.child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    })();
    return this.stopping;
  }
}
