# ADR 0004: Approved worktree execution and commit-bound validation

Status: implemented; real-provider smoke-tested on macOS with Codex CLI 0.153.4.

## Authority and isolation

Implementation starts only from an exact, durable human plan approval. Project execution defaults off and also requires a trusted-repository acknowledgement. The plan must have been produced by a successful Codex planning run: a fake plan cannot authorize real code changes. Approval can dispatch a build automatically only when execution was already enabled; enabling a project later does not silently dispatch old queued tasks.

The workflow rechecks current/approved revision pointers, canonical digest, human decision, task status, and the run’s owner/plan lease before changes. Queue rows/events commit before background work starts. No network operation or long Git command runs inside a database transaction.

Each task gets `factory/<uuid>-<slug>` and an app-managed worktree, anchored to the project’s recorded default-branch commit. The main checkout is never reset or switched; dirty files remain there and are not copied. The worktree root must resolve outside the registered checkout. Persist the intended path/branch/base before invoking Git, so partial creation can be reconciled. Existing paths/branches are not forced, overwritten, pruned, or deleted. Repositories with executable Git filters are blocked, and hooks, fsmonitor, global Git config, and commit signing are disabled for service Git operations.

## Model permissions

Use a fresh app-server session with the native read-only/no-network policy and verified disabled integrations. Add only app-owned list/read/write/delete file tools scoped to the verified task worktree. Native shell/Git execution stays disabled for the model. A local read-only provider sandbox does not prevent the separately authorized service from applying validated file operations inside that worktree.

The file boundary denies traversal, symlinks, Git metadata, sensitive paths, Git attributes/submodule metadata, ignored existing files, binaries, and files above 1 MiB. Edits/deletions require the digest from a current read. Writes are atomic replacements; executable mode of existing files is retained. Limit each attempt to 500 file-tool calls, 200 touched paths, and 10 MiB of writes. After cancellation, the guard rejects any late tool call. Model completion only produces a summary; actual Git state determines touched files and commits.

The service stages verified task changes and creates a local commit with an explicit factory identity. Mutating Git operations use owned process groups, cancellation, and a one-minute timeout. The model cannot commit, push, merge, or deploy. Existing partial/human worktree edits are preserved during explicit recovery; no reset occurs.

## Validation evidence

Validation is separate from model execution. Only the human-configured command argv arrays run, in the task worktree. Codex `command/exec` supplies a `workspaceWrite` sandbox rooted at the worktree plus a dedicated scratch directory, with network disabled and implicit `/tmp` write access excluded. The command environment gets an empty temporary HOME, a scratch npm cache, CI mode, and explicit safe variables; it does not inherit provider credentials or the service environment wholesale.

This is suitable for explicitly trusted repositories, not a guarantee that arbitrary malicious build scripts are safe. The installed legacy sandbox permits broader host reads than newer restricted-read profiles; unknown/untrusted execution stays disabled. Dependency installation and network permission expansion are not automatic. Projects must supply locally available dependencies/commands.

Persist check records before starting commands. Capture bounded stdout/stderr separately, decode UTF-8 across chunks, withhold incomplete lines, and redact before publishing to SQLite/log files. Logs are artifacts outside the task checkout. Use verified integer exit codes; process success or model claims alone never imply validation success. Cancellation requests command termination, then closes/kills the owned app-server process group if needed.

Each check is bound to HEAD and the canonical validation-command configuration. Require a clean committed worktree, compare HEAD/source fingerprints after every check, and invalidate earlier passes if a check edits source or changes HEAD. Missing commands are NOT RUN and block. Failures/timeouts preserve the commit and logs. Changing required check configuration invalidates passing evidence and blocks tasks awaiting code review. `CODE_REVIEW` requires fresh passing records for every configured command against the recorded current HEAD. Final review/acceptance/merge remain unavailable.

## Scheduling, cancellation, recovery

One shared semaphore allows two workers per service across planning/build/validation. Queue selection is FIFO within priority, with aging to keep lower-priority work from starving. Persistent run rows have owner IDs/PIDs, heartbeat timestamps, stage/recovery information, and exact approved artifact references. A unique database index excludes multiple queued/active runs per task. The runtime holds an exclusive transaction on a separate SQLite owner database for its lifetime; OS file locking prevents competing service owners and releases on crash. A PID sentinel remains for diagnostics and compatibility with older runtimes.

Task cancellation is durable immediately; low-level runs show stopping until processes terminate. Worktrees, staged edits, commits, and logs remain. Shutdown drains both worker queues before closing the domain database and releasing service ownership. Startup marks unfinished runs/checks interrupted and blocked, never successful, and verifies saved worktree metadata. It never blindly restarts workers or deletes recovery artifacts.

Recovery requires an explicit action against an inspected HEAD and full dirty-worktree fingerprint. A stale inspection is rejected. A previous surviving worker PID blocks recovery; no recovered PID is force-killed automatically because identity may be uncertain. Validation-only recovery requires a clean commit and avoids a new implementation turn. Provider sessions can be ephemeral because durable recovery state is independent of opaque session IDs.

Independent review, bounded repair loops, final acceptance, merge/deployment, signed packaging, and accepted-worktree cleanup are future milestones. This increment ends at code-review readiness, not task completion.

Official protocol reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server). Test evidence: [verification record](../verification.md).

## Follow-up

[ADR 0005](0005-review-repair-and-final-acceptance.md) extends the original Milestone 3 boundary with independent review, bounded repair, and final acceptance. Statements above that those gates are unavailable describe the historical increment.
