# Software Factory — Product & Technical Specification

**Status:** Build-ready MVP proposal  
**Version:** 0.1  
**Date:** 2026-11-20  
**Audience:** Solo developer / AI coding agent  
**Product type:** Local-first, single-user, human-supervised software development orchestrator

> **North star:** Turn a development request into a reviewed, test-backed change with two deliberate human checkpoints: authorization to implement, and acceptance of completed work. Agents do the intervening work; the human remains accountable for priorities, decisions, and merging.

## 0. Implementation decisions and assumptions

These are deliberate defaults so implementation can start without lengthy discovery.

| Decision | MVP choice | Why |
|---|---|---|
| Distribution | macOS-first desktop application, local execution | The initial user is one developer; no cloud service or multi-tenant infrastructure required. |
| Shell/UI | Tauri 2 + Vue 3 + TypeScript | Native desktop shell and flexible task-oriented UI. |
| Orchestrator | Long-running local Node.js/TypeScript companion process | Straightforward CLI/process control, streaming, Git, and SQLite integration. |
| Persistence | SQLite with migrations, WAL, and foreign keys | Durable state and crash recovery without external services. |
| Agent runtime | Codex app-server primary adapter | Documented thread/turn/event/approval protocol; compatible with supported ChatGPT sign-in routes. |
| Second provider | Claude Code CLI adapter, **opt-in and deferred** | Useful provider portability, but account/organization permissions and Anthropic terms must be checked. |
| Isolation | One Git worktree + branch per implementation task | Prevent concurrent agents from editing the same checkout. |
| Execution sandbox | Provider read-only sandbox for planning; bounded implementation sandbox | Prompts are not security controls. |
| Git hosting | Local Git first; optional GitHub PR integration later | Avoid requiring a remote or API token for first use. |
| Work allocation | One task per worker session; max 2 concurrent implementation workers | Simple recovery and controlled subscription usage. |
| Workflow | Explicit state machine + persisted domain events | Reliable human approvals, auditability, replayable UI updates. |
| Auto-assignment | Rule-based selection, never an LLM making uncontrolled spawn decisions | Predictable provider usage and policy enforcement. |
| Finalization | Never auto-merge or deploy in MVP | Final user sign-off is a required gate. |

**Not a requirement:** the desktop window remaining open while a worker runs. The local backend may continue while the UI is closed, **provided** the backend is intentionally launched and supervised. Laptop sleep, logout, or process termination can interrupt work; the MVP does **not** promise unattended 24/7 execution.

### Scope boundary and policy caution

This is a **personal** project. The Codex adapter must use an officially documented authentication/integration path; it must not scrape ChatGPT session cookies or promise that every feature is covered by a subscription. API-key billing and plan allowance are different configurations. For Claude, use the unmodified, officially distributed Claude Code CLI; do not collect, proxy, or persist subscription OAuth tokens. A work-provided account should **not** be used for personal projects without employer authorization. Anthropic's terms distinguish running Claude Code from building products using Claude's capabilities; verify the permitted usage before enabling this adapter. No credentials or proprietary work code should be imported from employer projects by default.

---

## 1. Vision and success criteria

### User journey

1. Register a local Git repository as a **Project**.
2. Create a **Request** in an inbox (feature, bug, refactor, chore) with acceptance criteria and optional references.
3. Convert the request into one or more **Tasks**; manually select an agent provider or choose **Auto-assign**.
4. An assigned **Planner** analyzes the codebase read-only, produces a structured proposal, and asks clarifying questions if needed.
5. The application pauses at **Plan Review**. User can answer, comment, revise, approve, or reject the proposal.
6. Upon explicit approval, an **Implementer** works on an isolated branch/worktree, produces commits, and runs validation.
7. An independent **Reviewer** evaluates the diff; the implementer fixes findings automatically up to a configured limit. Checks rerun after each fix.
8. The application pauses at **Final Review** with a change summary, diff, test evidence, and outstanding caveats.
9. User accepts, requests further changes, or rejects. Only an accepted task becomes **Done**; merging is a separate explicit action.

### MVP success metrics

- A new repository can be registered and its first task submitted in under five minutes.
- Every task preserves its history across application restart.
- No implementation work begins without a durable, version-matched plan approval.
- No task is marked accepted or merged without a durable final sign-off.
- A full request → plan → approval → build → review → final approval journey works in a sample repo.
- Failed worker runs never silently become completed tasks.
- Two simultaneous tasks cannot write to the same working tree.
- User can view the most recent meaningful progress, error, and required action for every task.

---

## 2. Domain model

**Important distinction:** **Request ≠ Task ≠ Agent Run.** Requests capture intent; Tasks represent durable units of deliverable work; Agent Runs are short-lived attempts to perform a stage. A failed run does not destroy its task.

- **Project:** Local Git repository and configuration (allowed commands, default branch, providers, limits).
- **Request:** Human-submitted goal with description, type, priority, attachments/references, optional acceptance criteria.
- **Task:** Scoped deliverable linked to one Request, state, assignee policy, proposed plan, approved plan revision, worktree/branch, final outcome.
- **Plan Revision:** Immutable proposal snapshot (summary, steps, assumptions, risks, files/areas, test strategy, questions, estimated scope). Each revision gets its own number.
- **Approval:** Human action against a specific task, gate (`plan` or `final`), and exact artifact revision/digest, with actor, action, feedback, and timestamp.
- **Agent Run:** One provider execution attempt for a stage (`plan`, `implement`, `review`, `repair`), tracking inputs, provider session reference, process, result, exit code, and timestamps.
- **Workspace:** Task-specific Git worktree, branch, base commit, creation/cleanup status.
- **Validation Run:** One tool execution, e.g. lint, typecheck, test, build; stores command, duration, exit code, redacted logs.
- **Review:** Versioned report against a specific commit/diff, structured findings, severity, and verdict.
- **Domain Event:** Append-only record for lifecycle and activity, useful for UI subscriptions and recovery.
- **Decision/Question:** An actionable human clarification request with answer, status, and associated plan revision or stage.

### Task decomposition (MVP)

Each Request initially produces **one Task**, unless the user manually splits it. Automatic decomposition into dependent multi-task DAGs is out of scope for MVP; the data model should reserve `parent_task_id` and future dependencies.

### Agent identity

“Planner,” “Implementer,” and “Reviewer” are **roles**, not autonomous permanent personalities. A role is performed by a provider session with stage-specific instructions and permissions. A task may be reassigned to another provider after a run ends. Never require one provider's opaque session ID to reconstruct durable task state.

---

## 3. State machine

### Canonical task statuses

```text
INBOX
  └─ assign ─→ PLANNING
                  ├─ needs input ─→ PLANNING_BLOCKED ── answer ─→ PLANNING
                  ├─ plan ready ─→ PLAN_REVIEW
                  └─ error ─→ FAILED
PLAN_REVIEW
  ├─ request changes ─→ PLANNING
  ├─ reject ─→ REJECTED
  └─ approve(plan revision N) ─→ QUEUED_FOR_BUILD
QUEUED_FOR_BUILD ─→ BUILDING
BUILDING
  ├─ error / permission blocker ─→ BLOCKED
  ├─ implementation finished ─→ VALIDATING
  └─ failed after retries ─→ FAILED
VALIDATING
  ├─ checks fail ─→ REPAIRING
  └─ checks pass ─→ CODE_REVIEW
CODE_REVIEW
  ├─ actionable findings ─→ REPAIRING
  └─ pass / acceptable warnings ─→ FINAL_REVIEW
REPAIRING
  ├─ changes complete ─→ VALIDATING
  └─ retry budget exhausted ─→ BLOCKED
FINAL_REVIEW
  ├─ request changes ─→ REPAIRING (or PLANNING if scope changed)
  ├─ reject ─→ REJECTED
  └─ accept exact reviewed commit ─→ ACCEPTED
ACCEPTED ── user-authorized merge ─→ MERGED
```

**Additional orthogonal run status:** `queued | starting | running | waiting_permission | stopping | succeeded | failed | interrupted | cancelled`. Do not overload task statuses to represent low-level worker state.

### Core transition rules (must be server-enforced)

1. Only the workflow engine transitions task state; renderer/UI cannot write statuses directly.
2. `PLAN_REVIEW → QUEUED_FOR_BUILD` requires a human `approve` decision against the **current** plan revision, with its digest unchanged.
3. `BUILDING` requires that a valid approval exists and is bound to the currently approved plan revision. The workflow engine creates the workspace **after** that check.
4. If requirements change materially after approval, invalidate the plan approval and return to `PLANNING` or `PLAN_REVIEW`.
5. Every implementation or repair that changes the commit invalidates prior validation/review results. `FINAL_REVIEW` requires both check and review evidence for the **current HEAD**.
6. `FINAL_REVIEW → ACCEPTED` requires human acceptance of the exact commit and evidence bundle shown. New commits invalidate acceptance.
7. `MERGED` requires explicit user intent and verification that the accepted commit is still the merge candidate. Final sign-off **does not** silently merge or deploy.
8. State changes use optimistic concurrency (`task.version`) inside a database transaction to avoid double approvals/spawns.
9. `FAILED`, `BLOCKED`, `REJECTED`, and `CANCELLED` require a visible reason and recovery action; `CANCELLED` is supported from any nonterminal active stage.
10. Each transition emits an append-only domain event in the **same transaction**. Events are delivered to UI subscribers afterward.

### Failure and recovery semantics

- **Process exit / crash:** Mark in-flight runs `interrupted` on restart after process liveness checks. Do not assume completion. Offer **Resume** or **Retry**.
- **Subscription exhausted / authentication error:** Set task `BLOCKED`, show provider-specific guidance; preserve workspace and agent output.
- **Agent asks for shell/network permission:** Pause that run and surface a distinct permission request; never silently bypass sandbox controls. Plan/final approvals are not substitutes for tool permissions.
- **Validation failure:** Automatically repair up to **3** loops, rerunning validation and code review against the new commit.
- **No forward progress / repeated identical diffs:** Stop loop and mark blocked, with last failure evidence.
- **Human edits task while worker runs:** Store comments; do not mutate live instructions mid-execution unless provider explicitly supports safe steering. Default to queueing them for next stage/revision.
- **Base branch changed or merge conflict:** Preserve task branch; show rebase/update choice instead of automatically overwriting files.
- **Cancel:** Signal stop, await process termination with timeout, terminate process tree if needed, preserve worktree and logs; user can later restart.

---

## 4. Functional requirements

Priorities: **P0** mandatory for first usable product; **P1** next iteration; **P2** future.

### Projects and requests

- **P0** Add/remove a local Git repository; detect valid Git root, current default branch, dirty working tree, worktree support and tool availability.
- **P0** Create/edit/archive a request: title, description, type, priority, acceptance criteria, project.
- **P0** Convert request into one task; task keeps a reference to the original request and its version.
- **P0** List tasks by status and provide search/filter by project, provider and priority.
- **P1** Attach files/links and import issues from GitHub/Linear.
- **P2** Agent-generated decomposition and dependency graphs.

### Assignment and planning

- **P0** Choose `Codex`, `Auto`, or an enabled second provider for each task.
- **P0** Auto policy: use project default if healthy and authorized; otherwise the first enabled/healthy provider according to explicit priority; do not silently switch providers during a run.
- **P0** Planning is **read-only** with no source edits or uncontrolled commands; output strict, validated structured data and readable Markdown.
- **P0** Allow agent to raise one or more clarification questions; user answers and resubmits plan generation.
- **P0** Show plan revisions side by side; allow **Approve**, **Request changes**, **Reject**.
- **P0** Persist exact approval/rejection, feedback, and revision hash.
- **P1** User can manually edit a plan before approval (creates new revision).

### Implementation and review

- **P0** On approval, create `factory/<task-id>-<slug>` branch in a dedicated worktree, anchored to a recorded base commit.
- **P0** Run implementer against the approved plan and acceptance criteria, with bounded tools and permissions.
- **P0** Stream progress events and show a terminal/log panel, not just a progress percentage.
- **P0** Run project-configured commands for lint, test, typecheck, build; absence of commands must be visible, not treated as a pass.
- **P0** Run a **separate review session** against task scope, diff, acceptance criteria, tests, and security risks; no write permissions for reviewer.
- **P0** Repair failing tests/review findings, at most 3 cycles; rereview and rerun tests after each change.
- **P0** Require final human acceptance for the **exact commit** shown.
- **P0** Offer **Open worktree**, **View diff**, **Copy branch**, and **Mark accepted**.
- **P1** GitHub PR creation, link PR and statuses, one-click user-authorized merge.
- **P1** Optional UI screenshots/preview URLs attached to review evidence.
- **P2** External CI status/webhook integrations and deployment controls.

### Agent oversight

- **P0** Show running/waiting/blocked agents in a dashboard.
- **P0** Allow **Stop**, **Retry**, **Resume if supported**, and **Reassign** once a run is stopped.
- **P0** Configurable concurrency caps, wall-clock timeout and repair cap; queue tasks when at cap.
- **P0** Permission requests and human approvals are explicit, durable, and auditable.
- **P1** Optional per-stage/provider model choice and estimated token/cost/usage signals **only where a provider exposes reliable data**; never invent subscription balance.
- **P2** Push/desktop notifications for tasks needing human action.

---

## 5. UX specification

### Navigation

1. **Dashboard:** Running sessions, tasks awaiting approval, recent failures, queue summary.
2. **Inbox:** New requests, triage, create task, auto-assign button.
3. **Board:** Kanban columns: Inbox, Planning, Plan Review, Building, Validation/Review, Final Review, Done; show blocked tasks prominently within their stage.
4. **Task Detail:** Tabs for Overview, Plan, Activity, Changes, Checks, Review, Decisions.
5. **Projects:** Git roots, default branch, validation commands, provider policy and sandbox.
6. **Settings:** Provider health/auth instructions, concurrency, timeouts, data location, retention.

### Human review screens

**Plan Review screen must show:** title, scope, acceptance criteria, plan revision number, agent/provider, assumptions, proposed file areas, step list, testing strategy, questions, risks, explicit approval controls, comments and historical decisions.

**Final Review screen must show:** commit SHA and base SHA, full changed-files list and diff, implementation summary, test matrix and captured logs, review findings and their resolution, known limitations, and buttons **Accept**, **Request changes**, **Reject**. No Accept button if required checks are failed/stale; if checks are waived, require an explicit separate documented waiver decision (post-MVP; MVP blocks instead).

### Interaction conventions

- UI buttons call commands; workflow engine verifies authorization and version.
- Subscribe to replayable event stream; on reconnect, fetch canonical snapshots then resume events from cursor.
- Show progress labels by stage/event, not invented `65% done` estimates.
- Distinguish **Agent waiting for tool permission**, **Waiting for plan approval**, and **Waiting for final approval**.
- Never display secret-bearing raw environment variables or complete provider tokens in logs.

---

## 6. System architecture

```text
Tauri Desktop (Vue 3)
    │ local authenticated IPC / loopback transport
    ▼
Factory Service (Node.js / TypeScript)
    ├── Command API + Event Stream
    ├── Workflow Engine / State Machine
    ├── Scheduler + Concurrency Controls
    ├── Approval & Permission Policy
    ├── SQLite Store + Event Log
    ├── Git Workspace Manager
    ├── Validation Runner
    └── Agent Runtime Interface
         ├── Codex app-server adapter [P0]
         └── Claude Code CLI adapter [P1 / gated]
               │
               └── restricted child processes in task-specific worktrees
```

A **single local service** is sufficient. Avoid Redis, distributed job queues, Kubernetes, a cloud-hosted API, and external orchestration frameworks for MVP.

### Process lifecycle

- On desktop launch, attach to an existing factory service or start one, with a locally scoped authorization secret or OS-protected IPC endpoint.
- Service owns DB writes, child processes, worktrees and workflow transitions.
- Provide a deliberate setting: **keep factory service running when window closes**; default **off** initially for simplicity.
- Shutdown gracefully: stop accepting new jobs, signal active processes, persist interrupted state.
- On startup, acquire a single-instance lock, run schema migrations, inspect in-flight runs, reconcile Git worktrees, emit recovery-required events.
- Bind HTTP to loopback only if used. Never expose unauthenticated local HTTP endpoints; prefer platform IPC where feasible.

### Repository safety

- Never run agents directly in user's main checkout.
- Keep worktrees under an app-managed directory (e.g. `~/.local/share/software-factory/workspaces/<project>/<task>` or OS-appropriate application data directory).
- Preserve uncommitted/dirty main checkout; record base commit and avoid changing checkout HEAD.
- For planning, use a read-only checkout/sandbox and disallow network and mutations unless explicitly necessary.
- For building, use least privilege and restrict filesystem scope to task workspace plus explicit temporary directories.
- Review agent uses diff/read-only permissions. No push, merge, deploy, secret access or production credentials as default capabilities.
- Keep project-configured validation commands allowlisted and execute as argument arrays (avoid shell string interpolation where possible).
- Treat repository content, README files, issue descriptions and tool output as **untrusted input**; they cannot grant permissions or bypass human gates.

---

## 7. Provider integration contract

An agent adapter must normalize provider-native events, preserving a pointer to original diagnostic data while minimizing stored secrets.

```ts
type ProviderId = 'codex' | 'claude';
type Stage = 'plan' | 'implement' | 'review' | 'repair';
type AgentEvent =
  | { type: 'run.started'; runId: string; at: string }
  | { type: 'message.delta'; runId: string; text: string }
  | { type: 'tool.started'; runId: string; tool: string; safeSummary: string }
  | { type: 'tool.finished'; runId: string; tool: string; success: boolean }
  | { type: 'permission.requested'; runId: string; requestId: string; summary: string }
  | { type: 'agent.question'; runId: string; question: string }
  | { type: 'run.usage'; runId: string; usage: Record<string, unknown> }
  | { type: 'run.finished'; runId: string; result: 'succeeded' | 'failed' | 'interrupted' };

interface AgentRunSpec {
  runId: string;
  taskId: string;
  stage: Stage;
  cwd: string;
  input: string;
  permissionProfile: 'read-only' | 'implementation';
  sessionRef?: string;
  timeoutMs: number;
}

interface AgentAdapter {
  id: ProviderId;
  health(): Promise<{ installed: boolean; authenticated: boolean; detail?: string }>;
  start(spec: AgentRunSpec, onEvent: (e: AgentEvent) => void): Promise<{
    sessionRef?: string;
    output: string;
    result: 'succeeded' | 'failed' | 'interrupted';
  }>;
  stop(runId: string): Promise<void>;
  resume?(spec: AgentRunSpec, onEvent: (e: AgentEvent) => void): Promise<void>;
}
```

The interface is illustrative; production implementation should use runtime validation, typed error codes, cancellation signals, bounded queues and protocol version checks. Never infer a successful implementation merely from a provider process exit code: verify expected stage artifacts and Git state.

### Codex adapter (P0)

- Use the documented **Codex app-server** protocol for threads, turns, streaming updates, approvals and interruption; favor supported login rather than manually handling ChatGPT credentials.
- Persist provider `threadId` per run (and only resume where compatible), along with run ID and stage.
- Handle `initialize`, thread creation/resumption, turn start, event consumption, turn completed/failed/interrupted status, and provider permission requests.
- Select read-only vs implementation sandbox/approval profiles according to current state; do **not** trust prompts as the only restriction.
- Verify auth and model entitlement by an actual supported request; do not treat advertised model lists as guaranteed access.
- If using the optional Sign in with ChatGPT plan-sharing/OAuth route, follow its **currently supported** client registration, access-token refresh, app-server configuration and eligibility requirements. Store secrets in OS keychain only, never in SQLite or agent logs. Do not assume API credits and subscription usage share a single pool.
- Integration spike must validate the exact installed protocol version against official docs before building the full adapter.

### Claude adapter (P1, policy-gated)

- Use officially installed, **unmodified** `claude` CLI in non-interactive mode; parse supported structured stdout, stderr, exit codes and session metadata. Do not parse its human-facing terminal output if structured output exists.
- Example *capability check*, not a license grant: `claude -p "Summarize this repository" --output-format stream-json --verbose`.
- Use CLI-managed authentication; never intercept/collect Claude OAuth/session tokens.
- Only enable after user affirmatively verifies their own license/employer authorization and current Anthropic terms. If not authorized, mark provider unavailable and offer API-key billing as a separate future integration.
- Do not assume feature parity: support only capabilities proven by the local CLI version; block workflows requiring unsupported granular permissions.

### Agent stage contracts

All stage prompts include: task ID, project context, acceptance criteria, **approved** plan (for implementation/review), workspace path, allowed tools, denied actions, output schema and stop conditions.

**Planner output** (schema-validate):

```json
{
  "summary": "Implement customer payment history UI",
  "assumptions": ["Payments API already exists"],
  "questions": ["Should failed payments appear?"],
  "steps": ["Inspect API contracts", "Create Vue view", "Write tests"],
  "affectedAreas": ["src/pages", "src/components"],
  "acceptanceCriteria": ["Paginated list", "Empty state", "Tests pass"],
  "testStrategy": ["Unit tests", "Integration tests"],
  "risks": ["Unclear pagination contract"]
}
```

**Implementer output:** short human-readable change summary, touched paths, commits (or note no commit), remaining known issues; truth checked from Git, not only the agent's claim.

**Reviewer output:** structured findings `{severity, file, line?, title, rationale, suggestedFix}` plus `verdict: pass | changes_requested | blocked`, anchored to a commit SHA. Critical findings block final review. Reviewer cannot modify code.

---

## 8. Persistence design

Use `INTEGER` row versions, UTC ISO timestamps, UUID IDs (or sortable UUIDv7), normalized JSON for variable payloads, and SQLite WAL.

### Required tables (minimum)

```text
projects(
  id PK, name, repo_path UNIQUE, default_branch, config_json,
  created_at, updated_at
)
requests(
  id PK, project_id FK, title, body, type, priority,
  acceptance_criteria_json, status, version, created_at, updated_at
)
tasks(
  id PK, request_id FK, project_id FK, parent_task_id NULL FK,
  title, status, version, provider_policy_json,
  current_plan_revision_id NULL, approved_plan_revision_id NULL,
  worktree_id NULL, accepted_commit_sha NULL,
  created_at, updated_at
)
plan_revisions(
  id PK, task_id FK, revision_number, body_json, body_markdown,
  sha256_digest, created_by_run_id NULL, created_at,
  UNIQUE(task_id, revision_number)
)
approvals(
  id PK, task_id FK, gate, action, artifact_id, artifact_digest,
  commit_sha NULL, feedback NULL, actor, decided_at
)
agent_runs(
  id PK, task_id FK, stage, provider, status, provider_session_ref NULL,
  process_pid NULL, attempt, started_at, finished_at NULL,
  exit_code NULL, error_code NULL, summary NULL
)
workspaces(
  id PK, task_id UNIQUE FK, path UNIQUE, branch UNIQUE, base_sha,
  head_sha NULL, cleanup_status, created_at
)
validation_runs(
  id PK, task_id FK, commit_sha, name, argv_json,
  exit_code NULL, log_path, started_at, finished_at NULL
)
reviews(
  id PK, task_id FK, run_id FK, commit_sha,
  verdict, findings_json, created_at
)
questions(
  id PK, task_id FK, plan_revision_id NULL FK, prompt, answer NULL,
  status, created_at, answered_at NULL
)
events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id, task_id NULL, run_id NULL,
  type, payload_json, created_at
)
```

Use separate tables for **permission requests** and **run artifact references** if needed during implementation; the `events` table alone should not be the source of truth for unresolved approvals or running processes.

### Data consistency

- All task status updates: transactional guard `WHERE id = ? AND version = ?`, then increment version and append event.
- For approvals, compute canonical JSON digest of the plan/artifact snapshot; approve only exact revision/digest.
- For final sign-off, record exact commit SHA and validation/review IDs included in presented evidence bundle.
- Keep large process logs as size-limited redacted files; DB stores paths and summaries. Ensure logs are never accidentally committed to user repositories.
- Retain accepted task data until explicit archive/delete; worktree cleanup should require accepted/merged status and explicit user action.

---

## 9. Application API and events

Expose a typed command layer behind desktop IPC. If using loopback HTTP, the paths below illustrate semantics and must be locally authenticated.

| Command | Behavior |
|---|---|
| `project.add(path, config)` | Validate Git repo, persist project. |
| `request.create(projectId, payload)` | Add inbox item. |
| `task.createFromRequest(requestId)` | Create durable task. |
| `task.assign(taskId, providerPolicy, expectedVersion)` | Select adapter / enqueue planning. |
| `task.answerQuestion(taskId, questionId, answer)` | Persist answer, resume planning. |
| `task.reviewPlan(taskId, revisionId, action, feedback, expectedVersion)` | Approve/revise/reject exact plan. |
| `task.run(taskId)` | Dispatch next allowed stage, no bypass of approvals. |
| `task.stop(taskId)` | Stop current run safely. |
| `task.retry(taskId)` | Retry only a recoverable state/stage. |
| `task.requestChanges(taskId, feedback)` | Create new work/review cycle. |
| `task.finalDecision(taskId, commitSha, action, feedback, expectedVersion)` | Accept/reject/request changes against exact evidence. |
| `task.merge(taskId, targetBranch, confirmation)` | **P1**, explicit user merge with fresh SHA checks. |
| `events.subscribe(afterSequence)` | Snapshot + ordered events / reconnection support. |

**Sample event names:** `request.created`, `task.assigned`, `run.started`, `plan.proposed`, `question.opened`, `plan.approved`, `workspace.created`, `validation.completed`, `review.completed`, `task.blocked`, `final_review.ready`, `task.accepted`, `task.merged`.

Commands return typed errors such as `INVALID_TRANSITION`, `STALE_VERSION`, `APPROVAL_REQUIRED`, `STALE_PLAN_REVISION`, `STALE_EVIDENCE`, `PROVIDER_UNAVAILABLE`, `WORKSPACE_CONFLICT`, `POLICY_DENIED`.

---

## 10. Scheduler and concurrency

Implement a small persisted scheduler, not an in-memory-only queue.

- Default maximum **2 concurrent agent runs** globally and **1 mutating run per task/worktree**.
- Read-only planning/review may run concurrently with unrelated tasks; never two mutating jobs on the same worktree.
- Queue ordering: first-in first-out by creation time within priority, with no starvation of low-priority tasks.
- A lease is recorded on `agent_runs` with heartbeat/last-seen time and owner process identifier; stale leases are **reconciled**, not automatically assumed safe to rerun.
- Define per-stage wall-clock timeouts and per-task max attempts (defaults: planning 2, implementation 2, repair 3 cycles); surface reason if exceeded.
- Auto-assignment checks provider installed/authenticated/authorized health and project preference; if unavailable, block and ask user rather than spawning endless retries.
- **Do not auto-spawn unlimited subagents**, even if provider supports them. Set provider-native limits where available.
- Provide an emergency **Stop all agents** control.

---

## 11. Security and privacy requirements

This application executes code generated from untrusted instructions, making containment a core feature—not a later optimization.

**P0 safeguards:**

- Treat repository content, request text, model responses and shell output as untrusted. Never interpret them as authorization to change workflow state or permissions.
- Enforce planning/review read-only at process/sandbox layer; verify no diff appears after read-only stages.
- Require user confirmation before file/network/process operations outside configured sandbox permissions; deny sensitive paths by default (`~/.ssh`, keychains, cloud config, work repositories unless explicitly registered, etc.).
- Keep OAuth/API secrets out of task prompts, repo files, logs, DB and UI event stream. Use OS keychain for any app-managed secrets.
- Restrict provider child process environment to an explicit allowlist; account for CLI-managed auth that may need inherited environment. Never forward entire parent environment blindly.
- Mask obvious credentials in logs, but **do not rely on masking as the only defense**. Limit access before execution.
- Protect local IPC; confirm task commands originate from the local authorized UI or authenticated client.
- Provide an up-front warning when enabling unrestricted shell/network execution; no silent sandbox bypass switches.
- Do not permit model-triggered Git push, merge, publish, release, payment or deployment without separate authorization.
- Sanitize paths, check for symlink escape and avoid shell-interpolating user-provided strings.
- Set resource limits and timeout for child processes; terminate process trees on cancellation.
- Preserve task data locally by default; explicitly state that repository contents are sent to the chosen AI provider under that provider's terms.

**Explicitly out of MVP security scope:** A guarantee that running untrusted build scripts is safe on the host. For unknown/untrusted repos, default to disable execution or require a dedicated disposable container/VM before running code. Git worktrees isolate edits, **not** filesystem access, secrets or network activity.

---

## 12. Suggested codebase organization

```text
software-factory/
├── apps/
│   ├── desktop/                 # Tauri 2 shell + Vue UI
│   │   ├── src/views/           # dashboard, inbox, board, task, projects, settings
│   │   ├── src/components/      # task card, approval panel, diff, run log, etc.
│   │   └── src-tauri/
│   └── factory-service/         # Node.js orchestration service
│       └── src/
│           ├── api/             # typed command handlers / event transport
│           ├── workflows/       # state machine and transition guards
│           ├── scheduler/       # persisted queue and concurrency
│           ├── agents/          # interface, Codex adapter, Claude adapter
│           ├── git/             # worktree/branch management
│           ├── checks/          # validation commands, review evidence
│           ├── policy/          # sandbox and approval permissions
│           ├── persistence/     # SQLite, migrations, repositories
│           └── recovery/        # startup reconciliation
├── packages/
│   ├── contracts/               # shared schemas/types/command definitions
│   ├── prompts/                 # versioned stage prompt templates
│   └── test-fixtures/           # sample git repos and fake agents
├── docs/
│   └── architecture-decisions/  # ADRs
└── scripts/
```

**Guidance:** Use a single workspace package manager and shared runtime schemas (e.g. Zod). Keep provider-native protocol objects out of UI/domain models. Use schema migrations from day one; use a fake provider adapter for deterministic integration tests.

---

## 13. Testing strategy

### Unit tests

- State-machine transition matrix, especially forbidden transitions.
- Approval version/digest checks and stale commit evidence invalidation.
- Auto-assignment preference/health logic.
- Event delivery ordering and idempotent command handling.
- Log redaction, timeout and cancellation code paths.

### Integration tests

- SQLite transactional state change + event write.
- Git worktree creation, branch collision prevention, dirty main tree preservation.
- Sample repo checks execution, log capture and status handling.
- Mock Codex adapter emits partial updates, permission request, failure, interruption and eventual success.
- Startup recovery of interrupted run + preserved worktree.
- Build/test changes invalidate old review evidence.

### End-to-end tests (fake adapter first)

1. Submit request → generate plan → approve → implement → tests pass → review pass → final accept.
2. Attempt implementation before plan approval → **denied**.
3. Agent asks question → task pauses → user answers → new plan revision produced.
4. Request plan changes → prior approval unavailable → must approve latest revision.
5. Tests fail → bounded repair loop → passes → fresh review.
6. Review fails repeatedly → task blocked, no unbounded calls.
7. Run interrupted mid-edit → app restarts → safely reports interrupted and offers recovery.
8. Commit changes after final evidence → final acceptance is denied until evidence regenerates.
9. Two tasks run simultaneously → isolated worktrees, main checkout untouched.
10. Cancel task → child process stops, task history and worktree remain.

### Real-provider smoke tests

On a disposable local demo repo, verify: provider health, actual planning sandbox restrictions, stream parsing, tool approval behavior, session resume (if supported), implementation, review and cancellation. Record tested provider CLI/protocol versions. Never run first smoke tests in sensitive/work repositories.

---

## 14. MVP delivery milestones

Each milestone should be independently demoable and shippable to the local machine.

### Milestone 0 — Scaffold and technical spikes

- [ ] Initialize monorepo, Tauri/Vue shell, Node service and shared contracts.
- [ ] Verify native packaging and service launch/stop lifecycle on macOS.
- [ ] Verify installed Codex app-server protocol and authentication using a disposable repo.
- [ ] Verify read-only planning and bounded implementation permissions empirically.
- [ ] Write ADRs for service transport, SQLite library, sandbox approach, and artifact paths.

**Exit:** UI can show service health; Codex spike streams a test run through the service.

### Milestone 1 — Persistent task management

- [ ] Add SQLite migrations and model repositories.
- [ ] Implement Projects, Requests, Tasks, Events and status transition engine.
- [ ] Build Inbox, Board, Project Settings and Task Detail shell.
- [ ] Add optimistic concurrency and startup recovery scaffolding.
- [ ] Add fake-agent adapter to exercise lifecycle without provider usage.

**Exit:** User can create, assign, inspect and restart a task without state loss.

### Milestone 2 — Planning and first human approval

- [ ] Implement Codex adapter health, start, stop, stream normalization and session refs.
- [ ] Implement read-only planning run and structured plan validator.
- [ ] Persist plan revisions and clarification questions.
- [ ] Build plan review UI: approve, request changes, reject, feedback history.
- [ ] Enforce exact plan version/digest approval gate.

**Exit:** No task can reach build queue without human approval of its current plan.

### Milestone 3 — Implementation and validation

- [ ] Create/track/clean task Git worktrees and branches.
- [ ] Implement scheduler and 2-run concurrency limit.
- [ ] Add implementation run, stop/cancel, progress/log stream.
- [ ] Add project-configured validation commands and result capture.
- [ ] Add failure and interruption recovery paths.

**Exit:** Approved task modifies only its task worktree, captures commits/checks and survives restart.

### Milestone 4 — Review loop and final human sign-off

- [ ] Implement separate read-only reviewer run with structured findings.
- [ ] Implement bounded repair → revalidate → rereview loop.
- [ ] Generate evidence bundle for exact commit.
- [ ] Build Final Review UI: diff, checks, review, accept/request changes/reject.
- [ ] Enforce final approval and no auto-merge; add task acceptance history.

**Exit:** End-to-end feature request can reach `ACCEPTED` only after human sign-off.

### Milestone 5 — Polish and optional providers

- [ ] Add usage/time-budget settings and provider health/errors.
- [ ] Add Claude Code adapter **only after terms and employer authorization review**.
- [ ] Add project/provider defaults and auto-assignment policy UI.
- [ ] Add desktop notifications, GitHub PR creation and explicit merge action (P1).
- [ ] Add app packaging, diagnostics export, backup and schema-migration testing.

**Exit:** Daily-driver quality for personal repositories with visible limits and recovery paths.

---

## 15. Acceptance checklist for v0.1

The MVP is considered complete when all are true:

- [ ] A user can register an existing Git repository with no cloud account.
- [ ] A user can enter a request, assign Codex manually or automatically and watch planning progress.
- [ ] Planner cannot write project source files; any violation is blocked or detected.
- [ ] Questions and plan revisions survive application restarts.
- [ ] Implementation is impossible without approval of the exact current plan revision.
- [ ] Implementation happens in a task-specific Git worktree, not the user's checkout.
- [ ] Validation and independent review results are tied to the exact HEAD commit.
- [ ] A bounded repair loop handles test/review failures and surfaces unrecoverable blockers.
- [ ] Final review shows accurate diff, checks, review findings, commit SHA and limitations.
- [ ] Acceptance requires explicit human action; merge/deploy never happens automatically.
- [ ] Cancellation, timeouts, subscription errors and process crashes produce a recoverable task state.
- [ ] No provider credentials are stored in task records or exposed in agent logs.
- [ ] Test suite includes approval bypass, stale evidence, worktree isolation and crash recovery cases.

---

## 16. Deliberate non-goals

Do **not** build any of the following in v0.1:

- Multi-user accounts, organizational roles, permissions, web-based cloud hosting or billing.
- Fully autonomous project decomposition, agent-to-agent task creation or unlimited agent swarms.
- Automatic deployment, production database operations, autonomous merges or releases.
- General-purpose chat product or provider-model marketplace.
- Arbitrary MCP/plugin installation by agents, or self-modification of factory source.
- A generalized distributed workflow engine or Kubernetes task execution platform.
- Accurate model cost/subscription-remaining counters unless officially supported by a provider.
- A guarantee of safe execution of arbitrary untrusted code on the host machine.

---

## 17. Open decisions (resolve during implementation spikes)

1. **Tauri child-process packaging:** precise macOS strategy for launching/persisting a signed Node companion service in development and in packaged releases.
2. **Sandbox enforcement:** provider sandbox sufficiency vs dedicated sandbox/container for execution of project-supplied build scripts.
3. **Transport:** authenticated local IPC vs loopback HTTP/WebSocket, and event replay mechanism.
4. **Provider entitlement:** exact supported Codex login/plan-sharing method in the released local app and its applicable usage limits.
5. **Claude authorization:** whether the user's employer permits personal workloads and whether the intended CLI orchestration is permitted under current Anthropic terms; adapter stays disabled until resolved.
6. **Accepted vs merged:** MVP defines `ACCEPTED` as task complete; merging is a separately authorized P1 action. Confirm whether that matches actual workflow after dogfooding.
7. **Validation default:** decide whether a project with no validation commands can reach `FINAL_REVIEW`. Recommended MVP: allow review, but show a prominent `NOT RUN` disclosure; require manual final sign-off to acknowledge missing tests.

---

## 18. Reference documentation

The following official documentation describes the intended integration direction; verify current details when implementing and pin/test the actual installed versions.

- Codex app-server: https://developers.openai.com/codex/app-server
- Codex SDK: https://developers.openai.com/codex/sdk
- Sign in with ChatGPT / Codex app-server plan use: https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server
- Claude Code programmatic CLI: https://code.claude.com/docs/en/headless
- Claude Code legal/compliance and credential policy: https://code.claude.com/docs/en/legal-and-compliance

---

## 19. First implementation prompt

Paste the prompt below into your coding agent **together with this specification file**:

> Implement **Milestone 0 and the foundations of Milestone 1** from `software-factory-spec.md`. Set up a Tauri 2 + Vue 3 + TypeScript desktop app, a local Node.js/TypeScript factory service, shared runtime-validated contracts, SQLite migrations, project/request/task/event domain types, and a strict state-transition service. Use a fake agent adapter first. Do not implement Claude integration or automatic code execution yet. Include unit tests for forbidden status transitions, approval requirements, and optimistic concurrency. Add a README with local development commands and an ADR explaining the service-to-desktop IPC choice. Make the app launch into a basic Inbox and Board with sample fixture tasks. Keep each milestone as a reviewable set of commits. Do not change unrelated files or ask for credentials.

**Product principle to preserve throughout implementation:** AI agents may propose, execute authorized work, test and review. Only the human can authorize a plan, accept completed work, or authorize a merge.
