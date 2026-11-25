import { startRuntime } from '../../apps/factory-service/src/runtime.ts';
const runtime = startRuntime(process.argv[2]);
console.log('runtime ready');
setInterval(() => {}, 1000);
process.on('SIGTERM', async () => { await runtime.close(); process.exit(0); });
