import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Request, RequestRevision, Review, EvidenceBundle, AgentRun, Approval, DomainEvent, PlanRevision, Project, Question, Snapshot, Task, ValidationRun, Workspace } from '../../../../packages/contracts/src/index.js';

const migration = `
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE requests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, body TEXT NOT NULL, type TEXT NOT NULL, priority TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE tasks (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), project_id TEXT NOT NULL REFERENCES projects(id), parent_task_id TEXT REFERENCES tasks(id), title TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, provider_policy_json TEXT NOT NULL DEFAULT '{}', current_plan_revision_id TEXT REFERENCES plan_revisions(id), approved_plan_revision_id TEXT REFERENCES plan_revisions(id), worktree_id TEXT REFERENCES workspaces(id), accepted_commit_sha TEXT, reason TEXT, recovery_action TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE agent_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), stage TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL, provider_session_ref TEXT, process_pid INTEGER, attempt INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, error_code TEXT, summary TEXT);
CREATE TABLE plan_revisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), revision_number INTEGER NOT NULL, body_json TEXT NOT NULL, body_markdown TEXT NOT NULL, sha256_digest TEXT NOT NULL, created_by_run_id TEXT REFERENCES agent_runs(id), created_at TEXT NOT NULL, UNIQUE(task_id, revision_number));
CREATE TABLE approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), gate TEXT NOT NULL, action TEXT NOT NULL, artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL, commit_sha TEXT, feedback TEXT NOT NULL, actor TEXT NOT NULL, decided_at TEXT NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL UNIQUE, base_sha TEXT NOT NULL, head_sha TEXT, cleanup_status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE validation_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), commit_sha TEXT NOT NULL, name TEXT NOT NULL, argv_json TEXT NOT NULL, exit_code INTEGER, log_path TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE reviews (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES agent_runs(id), commit_sha TEXT NOT NULL, verdict TEXT NOT NULL, findings_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE questions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), plan_revision_id TEXT REFERENCES plan_revisions(id), prompt TEXT NOT NULL, answer TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, answered_at TEXT);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT REFERENCES projects(id), task_id TEXT REFERENCES tasks(id), run_id TEXT REFERENCES agent_runs(id), type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX events_task ON events(task_id, sequence);
CREATE INDEX tasks_status ON tasks(status);
CREATE TRIGGER immutable_plan_update BEFORE UPDATE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'Plan revisions are immutable'); END;
CREATE TRIGGER immutable_plan_delete BEFORE DELETE ON plan_revisions BEGIN SELECT RAISE(ABORT, 'Plan revisions are immutable'); END;
CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'Events are append-only'); END;
CREATE UNIQUE INDEX one_active_run_per_task ON agent_runs(task_id) WHERE status IN ('starting','running','waiting_permission','stopping');
`;

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const current = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    if ((current.version ?? 0) > 6) throw new Error('Database schema is newer than this service');
    if (!current.version) this.transaction(() => {
      this.db.exec(migration);
      this.db.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run(new Date().toISOString());
    });
    if ((current.version ?? 0) < 2) this.transaction(() => {
      this.db.exec(`ALTER TABLE agent_runs ADD COLUMN turn_ref TEXT;
        ALTER TABLE agent_runs ADD COLUMN snapshot_path TEXT;
        ALTER TABLE agent_runs ADD COLUMN snapshot_digest TEXT;
        CREATE TABLE permission_requests (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES agent_runs(id), method TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    });
    if ((current.version ?? 0) < 3) this.transaction(() => {
      this.db.exec("ALTER TABLE agent_runs ADD COLUMN model TEXT; INSERT INTO schema_migrations VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ','now'));");
    });
    if ((current.version ?? 0) < 4) this.transaction(() => {
      this.db.exec(`ALTER TABLE projects ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE agent_runs ADD COLUMN owner_id TEXT;
        ALTER TABLE agent_runs ADD COLUMN owner_pid INTEGER;
        ALTER TABLE agent_runs ADD COLUMN heartbeat_at TEXT;
        ALTER TABLE agent_runs ADD COLUMN recovery_stage TEXT;
        ALTER TABLE agent_runs ADD COLUMN approved_plan_id TEXT REFERENCES plan_revisions(id);
        ALTER TABLE agent_runs ADD COLUMN approved_plan_digest TEXT;
        ALTER TABLE validation_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'interrupted';
        ALTER TABLE validation_runs ADD COLUMN log_text TEXT NOT NULL DEFAULT '';
        ALTER TABLE validation_runs ADD COLUMN reason TEXT;
        ALTER TABLE validation_runs ADD COLUMN run_id TEXT REFERENCES agent_runs(id);
        ALTER TABLE validation_runs ADD COLUMN config_digest TEXT;
        CREATE UNIQUE INDEX one_pending_run_per_task ON agent_runs(task_id) WHERE status IN ('queued','starting','running','waiting_permission','stopping');
        INSERT INTO schema_migrations VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    });
    if ((current.version ?? 0) < 5) this.transaction(() => {
      this.db.exec(`ALTER TABLE reviews ADD COLUMN summary TEXT NOT NULL DEFAULT '';
        ALTER TABLE reviews ADD COLUMN status TEXT NOT NULL DEFAULT 'current';
        CREATE TABLE evidence_bundles (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), commit_sha TEXT NOT NULL, body_json TEXT NOT NULL, sha256_digest TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TRIGGER immutable_evidence_update BEFORE UPDATE ON evidence_bundles BEGIN SELECT RAISE(ABORT, 'Evidence bundles are immutable'); END;
        CREATE TRIGGER immutable_evidence_delete BEFORE DELETE ON evidence_bundles BEGIN SELECT RAISE(ABORT, 'Evidence bundles are immutable'); END;
        INSERT INTO schema_migrations VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    });
    if ((current.version ?? 0) < 6) this.transaction(() => {
      this.db.exec(`CREATE TABLE request_revisions (request_id TEXT NOT NULL REFERENCES requests(id), version INTEGER NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(request_id,version));
        CREATE TRIGGER immutable_request_revision_update BEFORE UPDATE ON request_revisions BEGIN SELECT RAISE(ABORT, 'Request revisions are immutable'); END;
        CREATE TRIGGER immutable_request_revision_delete BEFORE DELETE ON request_revisions BEGIN SELECT RAISE(ABORT, 'Request revisions are immutable'); END;`);
      for (const request of this.db.prepare('SELECT * FROM requests').all() as Request[]) this.recordRequest(request.id);
      this.db.prepare('INSERT INTO schema_migrations VALUES (6,?)').run(new Date().toISOString());
    });
  }
  recordRequest(id: string) {
    const request = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as Request;
    this.db.prepare('INSERT INTO request_revisions VALUES (?,?,?,?)').run(id, request.version, JSON.stringify(request), new Date().toISOString());
  }
  requestForTask(task: Task): Request {
    const version = JSON.parse(task.provider_policy_json).requestVersion;
    const revision = this.db.prepare('SELECT body_json FROM request_revisions WHERE request_id=? AND version=?').get(task.request_id, version ?? 1) as { body_json: string } | undefined;
    if (!revision) throw new Error('The task request revision is missing; execution cannot use mutable request content.');
    return JSON.parse(revision.body_json) as Request;
  }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  task(id: string) { return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined; }
  plan(id: string) { return this.db.prepare('SELECT * FROM plan_revisions WHERE id = ?').get(id) as PlanRevision | undefined; }
  event(type: string, projectId: string | null, taskId: string | null, payload: unknown) {
    this.db.prepare('INSERT INTO events(project_id,task_id,type,payload_json,created_at) VALUES (?,?,?,?,?)').run(projectId, taskId, type, JSON.stringify(payload), new Date().toISOString());
  }
  events(after: number) { return this.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT 500').all(after) as DomainEvent[]; }
  snapshot(): Snapshot {
    const events = this.db.prepare('SELECT * FROM (SELECT * FROM events ORDER BY sequence DESC LIMIT 100) ORDER BY sequence').all() as DomainEvent[];
    return {
      projects: this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Project[],
      requests: this.db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all() as Request[],
      requestRevisions: this.db.prepare('SELECT * FROM request_revisions ORDER BY request_id,version').all() as RequestRevision[],
      tasks: this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as Task[],
      plans: this.db.prepare('SELECT * FROM plan_revisions ORDER BY revision_number').all() as PlanRevision[],
      approvals: this.db.prepare('SELECT * FROM approvals ORDER BY decided_at').all() as Approval[],
      runs: this.db.prepare('SELECT id,task_id,stage,provider,model,status,provider_session_ref,turn_ref,attempt,started_at,finished_at,error_code,summary,heartbeat_at,recovery_stage FROM agent_runs ORDER BY started_at').all() as AgentRun[],
      questions: this.db.prepare('SELECT * FROM questions ORDER BY created_at').all() as Question[],
      reviews: this.db.prepare('SELECT * FROM reviews ORDER BY rowid').all() as Review[],
      evidence: this.db.prepare('SELECT * FROM evidence_bundles ORDER BY rowid').all() as EvidenceBundle[],
      workspaces: this.db.prepare('SELECT * FROM workspaces ORDER BY created_at').all() as Workspace[],
      validations: this.db.prepare('SELECT id,task_id,commit_sha,name,argv_json,exit_code,status,log_text,reason,started_at,finished_at FROM validation_runs ORDER BY started_at').all() as ValidationRun[],
      providers: [],
      events, cursor: events.at(-1)?.sequence ?? 0,
      health: { provider: 'mixed', mode: 'Human-approved implementation in isolated worktrees', service: 'ready' },
    };
  }
  close() { this.db.close(); }
}
