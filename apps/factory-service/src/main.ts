import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { startRuntime } from './runtime.js';

// Private stdio channel: no listening socket, tokens, or credentials.
const runtime = startRuntime(process.env.FACTORY_DATA_DIR ?? resolve('.factory/desktop'), process.env.FACTORY_DEMO === '1');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let commands = Promise.resolve();
lines.on('line', line => { commands = commands.then(async () => {
  let response;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Request too large');
    response = await runtime.service.handle(JSON.parse(line));
  } catch { response = { ok: false, error: { code: 'INVALID_INPUT', message: 'Expected a JSON command under 1 MiB.' } }; }
  process.stdout.write(JSON.stringify(response) + '\n');
}); });
let closing = false;
const close = async () => { if (closing) return; closing = true; lines.pause(); await commands; await runtime.close(); process.exit(0); };
lines.on('close', close);
process.on('SIGINT', close);
process.on('SIGTERM', close);
