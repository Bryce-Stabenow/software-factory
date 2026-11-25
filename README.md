# Kulumin

A local, single-user software factory with deliberate human approval gates, built from [the product specification](software-factory-spec.md).

The app now supports **real Codex planning → exact plan approval → implementation in an isolated Git worktree → a local commit → configured validation → independent review → final human acceptance**. Progress, decisions, worktrees, checks, and recoverable failures persist in SQLite. A fake planner remains available for simulation and cannot authorize real execution.

Passing checks starts a fresh read-only reviewer. Test failures or actionable findings trigger up to three repairs, each followed by fresh checks and review. A passing independent review produces `FINAL_REVIEW`; only your decision can mark the exact reviewed commit `ACCEPTED`. Nothing is automatically merged, pushed, or deployed.

## Native app for daily use

The Apple Silicon macOS app bundles its Node runtime and SQLite addon. It runs without this source checkout, npm, or a separate Node installation. Git and Codex CLI (with your own sign-in) are still required for real tasks; checks need their own locally available dependencies.

Build and verify the local package:

```sh
npm run package:desktop
npm run test:package
```

Open `apps/desktop/src-tauri/target/release/bundle/macos/Kulumin.app`, or extract `release/Kulumin-0.1.0-macos-arm64.zip` and move the app to Applications. The ZIP has a SHA-256 sidecar and `release/release.json` with signing status. Runtime resources carry a separate verified manifest and licenses.

This machine has no Developer ID signing identity. The generated app is **locally ad-hoc signed and verified, not notarized**. Cross-machine distribution needs Developer ID signing and notarization. `APPLE_SIGNING_IDENTITY` selects an installed identity for local signing; the build never submits notarization automatically. Other CPU architectures/platforms are not claimed.

Release data lives at `~/Library/Application Support/local.kulumin.factory/`. Moving/replacing the app leaves that data intact. Release launches start empty, without demo repositories or enabled execution. Browser and development desktop databases are separate and are not silently moved. Use the backup workflow below if you want to move existing development data.

The native window uses private stdio IPC. Closing the window or quitting stops its service. Settings provides **Restart service** for a broken connection; interrupted work still needs explicit recovery. Finder launches search common local tool locations, including Homebrew and nvm, without running a login shell.

## Run from source

Requires Node **22.12+**, npm, and Git. Real workers require the locally installed Codex CLI and its existing sign-in (`codex login`). Native desktop development additionally needs Rust and the macOS Xcode command-line tools.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:1420**. The first launch creates a disposable sample repository, three requests, and two sample tasks. One task has a simulated proposal. Browser data lives in `.factory/browser/` and survives restarts.

```sh
npm run desktop
```

The desktop compiles and launches its Node companion over private stdio, with separate data in `.factory/desktop/`. Closing it drains workers and stops the companion; there is no background-running mode. This development shell needs the checkout and Node on PATH. Use the release package above for self-contained local use.

## Workspace interface

The desktop uses **Nuxt UI 4**, with a Linear-inspired neutral-gray layout, amber accents, and a persistent light appearance under **Settings → Appearance**. Requests open in an editor; issues open in a focused dialog with **Overview**, **Plan**, **Changes & checks**, **Review**, and **Activity** tabs. The properties rail keeps status and both human checkpoints visible.

Search lists by title or issue ID, filter by project/priority/provider, and switch Issues between list and board views. The Overview cards open matching issue filters. Request actions live in each row’s contextual menu.

- **Cmd/Ctrl-K** searches workspace actions, issues, and requests.
- **C** or **Cmd/Ctrl-N** opens a new request.
- **J / K** moves through the current list or board; **Enter** opens the focused item.
- **Esc** closes dialogs; **?** opens shortcut help.

Icons are bundled locally; the interface loads no remote fonts or icon services. Theme and reduced-motion preferences are respected without changing native CSP or approval requirements.

![Neutral and amber workspace](docs/screenshots/ui-amber-neutral.jpg)

## Requests and revisions

**Requests** offers **Edit request** and **Archive request** in the row menu, plus an active/archived/all filter. Open a request to save edits or create its task. Archived requests can be restored; archiving never cancels or hides their tasks from Issues or Overview. All updates use optimistic version checks and create immutable history.

Existing tasks continue to use the request version captured when they were created, including the original project and acceptance criteria. Editing the request does not alter an approved plan or implementation. **Create revised request** copies the latest request into a new identity so updated scope can receive its own task and approval.

## Diagnostics, backup, and recovery

Under **Settings → Operations & recovery**, inspect integrity, free storage, active/interrupted workers, heartbeat notices, and runtime/schema versions. **Export support report** saves a report under the data folder's `exports/`, excluding private paths, text, source, diffs, logs, account details, and credentials. **Open data folder** reveals the local files.

**Create database backup** saves a consistent online SQLite snapshot and shows its hash. Unlike a support report, a database backup contains private request text, captured diffs, and logs. It does not copy repositories or worktrees. Preserve those directories separately if moving machines.

Restore is offline and never overwrites existing databases. Quit the destination app, choose a new data directory, then run:

```sh
npm run restore -- --backup /absolute/path/backup.db --data-dir /absolute/path/new-data-directory
```

Without the source checkout, use the bundled runtime and restore tool:

```sh
kulumin_resources="/Applications/Kulumin.app/Contents/Resources/companion"
"$kulumin_resources/runtime/node" "$kulumin_resources/dist/scripts/restore-backup.js" --backup /absolute/path/backup.db --data-dir /absolute/path/new-data-directory
open -n /Applications/Kulumin.app --env FACTORY_DATA_DIR=/absolute/path/new-data-directory
```

Restore checks database integrity/schema and retains the original worktree paths. Keep the original service closed while using a restored copy. If the backup contains task worktrees, also pass `--env FACTORY_WORKSPACE_ROOT=/absolute/path/original-managed-worktree-root` when launching: a new data directory otherwise selects a new workspace namespace. The original managed root is the task worktree path with its final project-ID/task-ID directories removed. Missing or mismatched worktrees are blocked for inspection, never recreated or reset. Starting the app reconciles unfinished work as interrupted; it never dispatches recovered jobs automatically. To inspect a renderer startup failure locally, opt into `FACTORY_NATIVE_DEBUG=1` when launching the app and capture stderr. Those raw diagnostics are separate from the shareable support report.

## Use implementation and validation

1. Register a repository in **Projects**. Its default branch must have an initial commit. Dirty files in the main checkout remain untouched and are not copied into a task’s worktree.
2. Expand **Implementation & validation settings**. Leave execution disabled for unknown/untrusted repositories. For a trusted repository, acknowledge code execution, enable implementation, and configure check commands.
3. Enter checks as literal argument arrays, with unique names and bounded timeouts:

   ```json
   [
     { "name": "Typecheck", "argv": ["npm", "run", "typecheck"], "timeoutMs": 60000 },
     { "name": "Tests", "argv": ["npm", "test"], "timeoutMs": 120000 }
   ]
   ```

4. Create a request and task. Choose **Codex**, check the connection/models, and start planning. Planning uses a bounded read-only snapshot. Answer any clarification questions or request revisions before approval.
5. Approve the exact plan revision/digest. If project execution is enabled, a worker starts automatically; otherwise the task remains queued until you explicitly start it. Existing queued tasks are not dispatched just because settings change. Simulated plans never start a real implementation.
6. Watch the task’s worktree, base/current commit, diff, progress, and validation logs. Successful checks for the exact current commit start independent read-only code review. Older tasks already at `CODE_REVIEW` offer **Revalidate & review**.
7. Inspect **Final human review**: implementation/repair summaries, limitations, diff, required checks and captured logs, independent findings and history, base/current SHA, and evidence digest. Choose **Accept reviewed commit**, **Request changes**, or **Reject**. Changes/rejection require feedback. Requests for changes stay within the approved plan and use the same three-repair budget; new scope needs a new request and approval.

Checks need dependencies already available locally. The factory does not install dependencies or grant network access. Open the task worktree to prepare trusted dependencies yourself, or configure commands that work offline. Missing commands are disclosed as **NOT RUN** and block code review. Nonzero exits and timeouts trigger bounded repairs. Source/HEAD changes during validation and changed check configuration block progression and require inspection.

The implementer uses bounded list/read/write/delete tools confined to the task worktree. Shell, Git, network, plugins, and subagents are unavailable to the model. File edits require the digest from the latest read, and the service checks approval, task status, and run ownership before each operation. The service verifies and commits actual Git changes with hooks/signing disabled. Repositories with executable Git filters are currently blocked. Binary, symlink, protected metadata, and oversized file edits are unsupported.

Project code is sent to OpenAI through the signed-in Codex account. Snapshot/path exclusions and recognized credential redaction reduce exposure but do not guarantee arbitrary source is secret-free. Only use repositories suitable for that provider. Validation executes trusted project code under a no-network workspace sandbox and a restricted environment; worktrees are not disposable VMs.

## Cancellation and recovery

**Cancel task** and **Stop all workers** signal workers and terminate owned process groups as needed. The task’s branch, worktree, partial edits, commits, logs, and approval history remain. A stopping worker must terminate before recovery is available.

On restart, unfinished runs/checks become interrupted, never successful. Missing or changed worktree metadata is surfaced without resetting branches or recreating missing worktrees. A prior live process PID blocks recovery until inspected/stopped. The service owns an OS-backed exclusive SQLite lock in `service-owner.db`; a diagnostic `service.lock` also prevents overlap with older service versions. OS ownership releases on process crash.

For a stopped task, **Refresh changes**, inspect the current HEAD and diff, then choose **Resume implementation** or **Revalidate & review**. Recovery binds to the displayed HEAD and worktree fingerprint; stale inspections are rejected. Implementation continues in the existing worktree using a fresh Codex session. Validation-only recovery requires a clean committed worktree and does not invoke an implementer; it runs fresh checks and independent review. Full provider-session resume is not promised.

The shared queue permits **two workers per factory service**, including planning/build/check/review/repair stages. Implementation defaults to a 15-minute model deadline, two attempts per approved plan, bounded file writes, and one-minute bounds on mutating Git operations. Check timeouts are per command. Project settings cannot change while that project has pending/active runs. Changing required checks invalidates prior passing evidence and acceptance. Worktree edits or later commits likewise revoke current acceptance on inspection/restart, preserving decision history. Final decisions always recheck the current HEAD and full evidence digest server-side.

## Data and service configuration

Database and artifact paths are local. Per-task worktrees default to `~/Library/Application Support/Kulumin/workspaces/` on macOS, under an instance/project/task namespace outside registered checkouts. Validation logs and scratch directories live under the selected data directory’s `artifacts/`. Worktrees are retained; post-acceptance cleanup remains an explicit future feature.

- `FACTORY_DATA_DIR`: alternate Node service/browser-development data directory.
- `FACTORY_WORKSPACE_ROOT`: alternate managed worktree root; it must be outside registered repositories and must match the root used when recovering existing tasks.
- `FACTORY_CODEX_BINARY`: select another installed Codex CLI executable.
- `CODEX_HOME`: forwarded explicitly when set; credentials remain Codex-managed.
- `FACTORY_DEMO=1`: seed sample fixtures in the standalone service only if no projects exist. Browser/desktop development seed empty data automatically.

```sh
npm run build:service
npm run service
```

The service accepts one JSON command per stdin line, e.g. `{"type":"snapshot"}`. Standalone data defaults to `.factory/desktop/`; do not use that directory concurrently with the desktop. Browser development binds only to loopback and rejects cross-origin commands with exact host/origin checks and a non-simple header. Desktop transport has no HTTP endpoint.

## Verification

```sh
npm run typecheck
npm test
npm run build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline
```

Default tests use disposable repositories and protocol fixture subprocesses, **without model calls**. They cover approvals, concurrency, worktree isolation, local commits, validation truth/staleness, read-only review, bounded repairs, exact-commit final decisions, cancellation, process ownership, restart recovery, path protection, and credential-safe output streaming.

Opt-in real-provider checks use the existing Codex sign-in and disposable sample source:

```sh
npm run test:codex
npm run test:codex -- --probe-only
npm run test:implementation
```

The implementation smoke test makes real planning, implementation, independent review, and human-requested repair turns, approves/accepts only its disposable fixture, verifies fresh commits/checks/reviews and exact final acceptance, preserves the main checkout, probes workspace-write/network restrictions, and checks validation process-tree cancellation. Tested with **Codex CLI 0.153.4**. A model catalog is not an entitlement guarantee; access is verified by successful inference. Models are selected before a run and never silently changed mid-run.

See [implementation status](docs/implementation-status.md), [verification record](docs/verification.md), [review/acceptance ADR](docs/architecture-decisions/0005-review-repair-and-final-acceptance.md), [daily-use desktop ADR](docs/architecture-decisions/0006-daily-use-desktop-and-request-history.md), and [worktree/execution ADR](docs/architecture-decisions/0004-approved-worktree-execution.md). Richer provider/auto-assignment policy, optional notifications/PR integration, notarized distribution, and explicit worktree cleanup remain future work. Claude stays disabled.
