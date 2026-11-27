# Implementation status

## Delivered: scaffold and persistent planning foundation

- npm workspace with Vue 3 / TypeScript, Tauri 2 shell, Node service, and shared Zod contracts.
- Private desktop stdio bridge and separate loopback browser development bridge.
- SQLite migration 1, WAL, foreign keys, transactional workflow updates, immutable revisions and append-only events.
- Git project registration; requests; one task per request with captured request version.
- Inbox, Board, Dashboard, Projects, Settings, and task detail / plan review UI.
- Deterministic fake planning adapter and explicit simulation disclosures.
- Durable exact-plan decisions; request-changes feedback creates a new revision.
- Optimistic concurrency, version/digest rejection, cancel history, and interrupted fake-run reconciliation.
- Event cursor/replay contract, sample fixtures, and workflow/persistence tests.

The first increment covered the scaffold and Milestone 1 foundations. Native packaging and request edit/archive still need work. The next increment below delivers the real planning slice of Milestone 2.

## Delivered: real Codex planning and first approval gate

- Codex app-server JSONL adapter tested against installed CLI **0.153.4**, with CLI-managed sign-in, health, and model catalog.
- Explicit model selection or catalog default, persisted per run; no mid-run fallback.
- Per-run bounded text snapshots, exact allowlisted list/read tools, path/privacy filters, and snapshot integrity checks.
- Disabled execution/integration capabilities and verification of the effective CLI policy. Inherited MCP servers are individually disabled before any thread is created.
- Read-only/no-network sandbox probes passed on disposable files and a loopback endpoint.
- Asynchronous persisted planning queue with at most two active planning runs.
- Structured proposals, session/turn references, meaningful progress, five-minute timeout, cancellation, manual retry, and restart interruption handling.
- Persisted clarification questions and answers; answers and review feedback produce new immutable revisions in fresh sessions.
- Exact-plan revision/digest approval remains mandatory. Real proposals stop at Plan Review; approved tasks stop at the build queue.
- Default tests use subprocess protocol fixtures. A separate opt-in real-provider smoke test verifies actual sign-in, repository reads, structured output, and sandbox restrictions.

## Delivered: approved implementation, validation, and recovery

- Per-project trusted execution setting and versioned validation command configuration; execution defaults off.
- Fresh approval checks before workspace creation and every model file operation. Simulated plans cannot start real implementations.
- One recorded base commit, unique branch, and dedicated managed Git worktree per task; dirty main files/HEAD remain untouched.
- Bounded worktree file tools with digest preconditions, protected paths, and no model shell/Git/network access.
- Cancellable Git checkout/staging/commit operations; verified local commit metadata captured by the service.
- Sandboxed configured checks using literal argv, bounded time/output, credential-safe streamed logs, and exact HEAD/config evidence.
- No commands, failed/timed-out checks, mutated source, changed HEAD, and changed required checks block progression; no fabricated pass.
- Shared two-worker scheduling across planning/build/checks, persisted queues, owner leases/heartbeats, and per-task exclusion.
- Single-service ownership backed by an OS-released exclusive SQLite lock, with legacy PID protection.
- Cancellation/emergency stop preserve worktrees; restart interrupts unfinished runs and requires explicit recovery from inspected HEAD/content.
- Recovery can finish partial implementation or re-run checks without invoking an implementer; missing worktrees/branch collisions are never overwritten or cleaned automatically.
- Project settings, worktree path/branch/diff/commit inspection, check logs, recovery actions, and open/copy controls in the UI.
- A real-provider fixture completed plan → approval → implementation → commit → passing validation and remained `CODE_REVIEW`, awaiting independent review.

## Delivered: independent review, bounded repairs, and final human acceptance

- Separate fresh Codex read-only review sessions with bounded snapshot tools, actual source-read evidence, structured severity/path findings, and exact-commit verification.
- Snapshot and worktree integrity checks; omitted unsafe changed files or truncated diffs block review.
- Durable implement/check/review/repair run records sharing the existing ownership, cancellation, recovery, and two-worker limit.
- At most three persisted repair attempts per approved plan for failed/timed-out checks, reviewer defects, and human-requested changes; each attempt revalidates and rereviews.
- Immutable exact-commit evidence bundles with diff, checks/logs/configuration, review/findings history, summaries/limitations, and feedback history.
- Final Review UI with accept, request changes, and reject. Server-side gates bind decisions to task version, artifact ID/digest, current clean commit, approved plan, and current check/review evidence.
- Durable acceptance history and accepted commit; changed source/HEAD/check configuration revokes current acceptance on inspection/restart while preserving prior decisions.
- Explicit continuation for older code-review-ready tasks; interrupted reviewer/repair and orphaned stage recovery never assume success.
- Verified with 89 passing default tests, production builds/typechecks, a real Codex repair/revalidate/rereview/acceptance smoke test, and browser final-decision interaction.

## Delivered: request management, operational diagnostics, and local desktop packaging

- Immutable, versioned request edits and reversible archive/restore with active/archived/all filters.
- Tasks retain their original request inputs through planning/build/review and scheduling. Revised requests create separate tasks and approvals.
- Privacy-filtered health/storage/integrity/heartbeat/error-code reports, private export files, and content hashes.
- Consistent online database backups, shutdown draining, and a non-overwriting offline restore tool with integrity/schema verification.
- Self-contained Apple Silicon macOS app with bundled Node/native SQLite, licenses, resource manifest, ZIP, and checksums. Release data is independent of checkout; release launches do not seed demo projects.
- Native stdio worker with response bounds, UI-thread separation, explicit service restart, and close/quit shutdown. Frontend schema validation runs without CSP unsafe-eval.
- 97 passing default tests. Relocated-package tests verify signatures/resources, checkout/Node independence, persistence, backups, and bundled restore. Native UI exercised request creation/edit/archive/restore, Codex discovery, diagnostics export, backup, restart, and shutdown with disposable data.

## Delivered: cohesive Nuxt UI desktop redesign

- Real Nuxt UI 4 components integrated into the existing Vue/Vite/Tauri shell, including dialogs, command palette, tabs, forms, selects, menus, tooltips, badges, alerts, disclosures, and toasts.
- Linear-inspired compact sidebar, neutral-gray/amber palette, clear typography and spacing, dense request/issue rows, and optional persistent light appearance.
- Search by title/ID, project/priority/provider/status filters, overview navigation, list/board switching, and keyboard commands.
- Focused request/repository dialogs and task detail tabs with a properties/checkpoint rail; request edit/archive/restore actions remain available through contextual menus.
- Readable Git diffs with line numbers and addition/removal colors; check logs, review history, immutable digests, cancellation, and recovery retain the existing backend boundaries.
- Locally bundled Lucide icons and system font fallbacks, unchanged native CSP, and reduced-motion support.
- All 97 regression tests, typechecking/production builds, release packaging, and relocated-package verification pass. Browser request-management/theme/navigation interactions and the packaged native command palette, tabs, diff, exact-commit evidence, and close lifecycle were exercised with disposable data.

## Delivered: direct task start and guided project setup

- Request submission offers Save for later or Start task, with explicit planner/model choices. Starting queues read-only planning immediately; saved request menus offer Start task with Codex.
- Atomic, version-checked request.startTask creates/assigns a task transactionally, reuses unstarted tasks, rejects archived/stale/started requests, and rolls back partial creation on queue failure.
- Connecting a project opens its settings immediately. Existing projects have an explicit settings action; planning-only setup and deferral keep execution disabled.
- Named validation rows replace JSON editing, with command examples, an explanation of checks, timeouts, quoted argument support, and clear dependency/network requirements. Explicit trust and plan approval remain mandatory for implementation.
- 104 regression tests, production build/typechecking, native packaging/signature checks, relocated-package verification, and browser flow checks pass. The installed app was updated and its project/request/approval data fingerprint remained unchanged.

## Delivered: validation setup failure handling and recovered real task

- Missing check tools/dependencies and denied IPC-socket startup now block for setup without invoking code repairs or spending the approved plan's repair budget.
- Worktree/project help explains that ignored dependencies are local to each worktree and gives the locked npm development-install command.
- Kulumin's tests load tsx through Node rather than the CLI, preserving test coverage without the sandbox-blocked IPC socket.
- Recovered the real File selection task: resolved npm/Cargo locks, provisioned its dependencies, verified the packaged native picker and browser fallback, committed repairs on its isolated branch, and passed real Tests/Typecheck/Build plus fresh independent review. It remains FINAL_REVIEW awaiting human acceptance; no merge or approval bypass occurred.
- 107 regression tests and production/native package checks pass.

## Remaining work and optional extensions

1. Developer ID signing/notarization for cross-machine distribution; Intel/universal and non-macOS packaging verification.
2. Richer provider defaults/auto-assignment, broader task filters, and optional desktop notifications/PR integration.
3. Explicit post-acceptance worktree cleanup and separately authorized merge features.

The package produced here is locally ad-hoc signed and signature-verified. It is not notarized. Only the human accepts completed work. There is no push, merge, deployment, or automatic cleanup. Unknown/untrusted project execution remains disabled.

## Codex usage allowance in Settings → Providers

- Health retrieves `account/rateLimits/read` with empty parameters through the existing configured, authenticated app-server connection. No thread or turn is started. Simulation and Claude Code do not expose usage.
- The compatibility boundary accepts `rateLimits` (legacy snapshot) and `rateLimitsByLimitId` (named snapshot map). Each snapshot may contain `limitId`, `limitName`, `primary`, `secondary`, `planType`, and `credits`. Windows use numeric `usedPercent`, `windowDurationMins` in minutes, and `resetsAt` in Unix **seconds**, converted to ISO timestamps. Numeric strings and guessed timestamp units are not accepted.
- All named groups and primary/secondary window objects are retained, including partial windows with explicitly unknown values. The legacy summary is omitted when its limit ID matches a usable named group or its normalized allowance is identical. Distinct named groups are not deduplicated. Percent left is bounded to 0–100; elapsed resets do not replenish it.
- This schema supplies no authoritative model association. Groups are labeled shared account limits, never attributed to a selected/catalog model. Unknown model fields are ignored. Plan names are allowlisted; credits expose boolean availability/unlimited flags and a numeric string balance in provider units, without a fabricated percentage.
- A single 35-second health deadline includes configuration retries, authentication, catalog, and usage, plus a 500ms subprocess cleanup grace period. Usage and catalog reads each have a five-second request timeout. Usage failures preserve established authentication and catalog results. JSON-RPC -32601 means unsupported; missing analytics, malformed responses, failures, and sign-out have distinct usage states.
- Health refreshes coalesce in the service and replace the in-memory snapshot. Failed refreshes and sign-out clear previous usage. Usage is not persisted or included in diagnostics exports; raw responses, account IDs, credentials, and raw provider errors are not forwarded.
- Opening Settings → Providers refreshes unchecked snapshots or those older than 60 seconds. Refresh usage and Check connection use the existing health command. There is no periodic usage polling; the two-second workflow event polling does not call the provider and pauses during UI-triggered health checks.
- The display renders available windows, explicit percentage-left text, accessible native progress indicators, provider durations, local reset/last-checked times, plan and credit data, and shared-limit labels. Transport errors hide old allowances until a successful refresh.

Compatibility and verification limits: this implementation environment exposes only repository file operations and the configured verification runner. It cannot inspect an installed Codex protocol schema, contact a real provider, or launch browser/native interaction tools. The response shapes above are explicit compatibility assumptions exercised by the synthetic, sanitized `tests/fixtures/codex-usage.json` and app-server fixture, not a claim of live-provider verification. Previously recorded CLI 0.153.4 planning checks do not verify this usage endpoint. Unknown protocol additions require an adapter update. Visual checks of narrow layouts/both themes and browser/native refresh interaction remain unperformed here; component server rendering and presentation behavior are covered automatically.

Verification attempt 1 (factory verification service): `npm test` exceeded the configured 300-second timeout (exit 124). Its returned log contains 21 passing existing build/worktree tests and no assertion failures before termination; it does not establish the full suite result or the new usage tests' result. The runner stopped before Typecheck and Build. Checks and timeout remain unchanged. A subsequent verification attempt is required after the final edits.
