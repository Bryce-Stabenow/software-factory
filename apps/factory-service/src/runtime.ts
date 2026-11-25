import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './persistence/store.js';
import { FactoryService } from './service.js';
import { seedDemo } from './fixtures.js';
import { acquireRuntimeLock } from './persistence/runtime-lock.js';

export function startRuntime(dataPath: string, demo = false) {
  const dataDir = resolve(dataPath);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const releaseLock = acquireRuntimeLock(dataDir);
  let store: Store | undefined;
  try {
    store = new Store(join(dataDir, 'factory.db'));
    const service = new FactoryService(store, { dataDir, workspaceRoot: process.env.FACTORY_WORKSPACE_ROOT });
    service.recover();
    if (demo) seedDemo(service, dataDir);
    let closing: Promise<void> | undefined;
    return { service, close() {
      // Every caller must await the same drain; an HTTP-close event and Vite's
      // closeBundle hook can race during a configuration hot restart.
      closing ??= (async () => { await Promise.all([service.planning.close(), service.builds.close()]); await service.operations.close(); store!.close(); releaseLock(); })();
      return closing;
    } };
  } catch (error) { store?.close(); releaseLock(); throw error; }
}
