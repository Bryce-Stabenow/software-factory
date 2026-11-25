# ADR 0002: SQLite, immutable artifacts, and disabled execution

Status: accepted for the foundation.

Use `better-sqlite3`, pinned by the npm lockfile, for short synchronous transactions in one service. Enable WAL, foreign keys, a busy timeout, and ordered schema migrations. Migration 1 reserves the spec’s core entities, including runs, workspaces, validations, and reviews; only the project/request/task/planning slice is operational. A future schema version is rejected rather than silently read by an older service.

All task transitions run in an immediate transaction with a version-guarded update. The transition and append-only event commit together. Plan review records the human actor, exact revision, and canonical JSON SHA-256 digest in the same transaction. Building rechecks the durable approval, not merely a status flag. SQLite triggers prevent modifying/deleting plan revisions and domain events. Approval history is append-only through the command interface.

The initial adapter returns deterministic proposals without reading a repository. It performs no provider calls or implementation work. Queueing a plan does not create a worktree or start a process. Final review, acceptance, and merge are explicitly blocked until verified commit evidence is implemented. Prompt text never substitutes for a permission boundary.

Development database, lock, and disposable sample-repository artifacts live in an ignored `.factory/` directory. Native browser and desktop data are separated. Packaged releases should migrate these to the platform application-data directory and place worktrees/logs outside registered repositories. Retention/cleanup is deferred; no automatic deletion of user task data is implemented.

Unresolved: provider sandbox verification, containment for untrusted validation scripts, process-tree cancellation, OS advisory locking, signed companion packaging, and exact evidence bundles. These are prerequisites for enabling real code execution, not capabilities inferred from the fake adapter.

Update: ADR 0003 supersedes the fake-only planning boundary. Real read-only Codex planning is enabled; mutating execution remains disabled. Migrations 2 and 3 add snapshot/session/model metadata and durable denied permission requests.

Update for implementation: ADR 0004 enables exact-approved worktree file operations and trusted configured checks. Migration 4 adds project versions, run ownership/heartbeats, recovery references, and validation status/config/log evidence. Final acceptance and merge remain disabled.
