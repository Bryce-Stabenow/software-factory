import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FactoryService } from './service.js';
import type { Task } from '../../../packages/contracts/src/index.js';
import { git } from './git/workspaces.js';

export function seedDemo(service: FactoryService, dataDir: string) {
  if (service.store.snapshot().projects.length) return;
  const path = join(dataDir, 'demo-repository');
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'ignore' });
  writeFileSync(join(path, 'README.md'), '# Factory demo\n\nA disposable repository for simulated planning.\n');
  git(path, ['add', '--', 'README.md']);
  git(path, ['-c', 'user.name=Kulumin Factory', '-c', 'user.email=factory@localhost', 'commit', '--no-gpg-sign', '-m', 'Initialize disposable playground']);
  const project = service.dispatch({ type: 'project.add', name: 'Factory playground', path });
  if (!project.ok) throw new Error(project.error.message);
  const projectId = (project.data as { id: string }).id;
  for (const [index, title] of ['Add an empty state to the dashboard', 'Make task history searchable', 'Document local development setup'].entries()) {
    const request = service.dispatch({ type: 'request.create', projectId, title, body: 'A sample request to explore the software factory workflow. Replace this with your own request when ready.', kind: index === 2 ? 'chore' : 'feature', priority: index === 0 ? 'high' : 'normal', acceptanceCriteria: ['The behavior is covered by validation.', 'The change is ready for human review.'] });
    if (!request.ok) throw new Error(request.error.message);
    if (index === 2) continue;
    const task = service.dispatch({ type: 'task.createFromRequest', requestId: (request.data as { id: string }).id });
    if (!task.ok) throw new Error(task.error.message);
    if (index === 0) {
      const value = task.data as Task;
      const assigned = service.dispatch({ type: 'task.assign', taskId: value.id, expectedVersion: value.version, provider: 'fake' });
      if (!assigned.ok) throw new Error(assigned.error.message);
    }
  }
}
