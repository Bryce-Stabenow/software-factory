import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../factory-service/src/runtime.ts';

function developmentService(): Plugin {
  let runtime: ReturnType<typeof startRuntime> | undefined;
  return {
    name: 'factory-development-service',
    async closeServer() { await runtime?.close(); },
    configureServer(server) {
      // Tauri owns its service via private stdio. This bridge is browser-dev only.
      if (process.env.TAURI_ENV_PLATFORM) return;
      // Vite 8 constructs the replacement server before closing the old one.
      // Acquire the database only on the first authenticated request, after listen.
      const getRuntime = () => runtime ??= startRuntime(process.env.FACTORY_DATA_DIR ?? fileURLToPath(new URL('../../.factory/browser', import.meta.url)), true);
      server.httpServer?.once('close', () => { void runtime?.close(); });
      const onExit = () => { void runtime?.close(); };
      process.once('exit', onExit);
      server.httpServer?.once('close', () => process.removeListener('exit', onExit));
      server.middlewares.use('/__factory', async (req, res) => {
        const origin = req.headers.origin;
        const host = req.headers.host;
        // Exact loopback host, same-origin requests, and a non-simple custom header.
        // Cross-origin pages cannot set this header without a denied CORS preflight.
        if (req.method !== 'POST' || host !== '127.0.0.1:1420' || origin && origin !== 'http://127.0.0.1:1420' || req.headers['x-factory-client'] !== 'local-development') {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('Too large'); chunks.push(Buffer.from(chunk)); }
          const result = await getRuntime().service.handle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(result));
        } catch { res.writeHead(400); res.end('Invalid request'); }
      });
    },
  };
}
export default defineConfig({ plugins: [vue(), ui({ colorMode: false, router: false, autoImport: false, components: { dts: 'src/components.d.ts' }, ui: { colors: { primary: 'violet', neutral: 'zinc' } }, icon: { clientBundle: { scan: { globInclude: ['**/*.{vue,ts}'] } } } }), developmentService()], clearScreen: false, server: { port: 1420, strictPort: true, host: '127.0.0.1' }, build: { target: 'es2022' } });
