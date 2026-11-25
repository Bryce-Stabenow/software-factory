# Verification — 2026-11-24

Environment: macOS, Node 22.12.0, npm 10.9.0, Rust 1.99.1. Exact JavaScript and Rust dependencies are pinned in the lockfiles.

Passed:

- `npm run typecheck`.
- `npm test`: all 15 tests passed.
- `npm run build`: service compilation and Vue production build.
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --offline`.
- Browser UI smoke test: create request with acceptance criteria → create task → generate fake plan → request changes → observe revision 2 and feedback → approve exact revision → observe `QUEUED_FOR_BUILD` and persisted decision history → inspect Board.
- `npm run desktop` compiled and started the native development binary and its companion. The desktop SQLite database, WAL, fixtures, and service-owner lock were created.
- Stopping the development launch closed the companion, removed its owner lock, and checkpointed SQLite. Native window-close behavior still requires a UI check.

Native visual interaction was not verified: the available computer-use tool did not expose the unbundled Tauri development binary as an application surface. Browser UI interaction exercised the same Vue views and command dispatcher; it does not prove native IPC behavior or window-close behavior. These remain explicit verification work, along with signed companion packaging and real Codex integration.

The UI smoke test used the disposable playground only. No model calls or source execution occurred. Test fixtures use temporary repositories and preserve dirty source files. Real worktree isolation, validation, provider sandboxing, final evidence, and final acceptance are not claimed by this foundation.

## Real planner increment

Tested Codex CLI **0.153.4** against its generated experimental schema and the official app-server documentation. The completed inference used the CLI catalog default (`gpt-6-astra` in this environment); model access was verified by an actual successful turn, not a catalog listing.

Passed real-provider checks:

- CLI-managed sign-in via `account/read`, with no account email or credentials in app snapshots.
- Effective disabled-tool policy, including explicit overrides for inherited MCP servers.
- Fixed write probe denied by the read-only sandbox; original disposable source unchanged.
- Fixed HTTP probe to a live temporary loopback endpoint denied by `networkAccess: false`; endpoint received zero requests.
- Read-only repository tools were called during a real planning turn, final structured JSON validated, and the task reached `PLAN_REVIEW` with thread/turn/model references and no approval created.
- Browser UI: check connection → create a playground README request → choose real Codex → observe progress and repository list/read activity → view the resulting real plan at the human approval gate. The plan was left unapproved.

An early smoke test exposed an unsupported inherited CLI model; using the catalog default fixed it. Another exposed dynamic-tool dispatch dependence on the local code-mode host; that host remains available while model code-mode is disabled. The adapter now rejects completed proposals without repository-read evidence. A final configuration check caught empty-table MCP override merging; explicit per-server overrides are now verified before creating a thread.

Implementation, build/test execution, full implementation-worktree isolation, independent code review, and final acceptance remain unimplemented and are not claimed by these checks. The native shell compile check passes; native visual verification and signed packaging remain open.

Final regression checks: **35 tests passed**, TypeScript checks passed, and the production service/UI build passed. Tests include inherited-integration disabling, missing repository-read evidence, two-run concurrency, explicit model retry, immutable revisions, cancellation, and concurrent shutdown callers. The real-provider smoke test passed with the final verified tool policy and snapshot-integrity checks enabled.

Restart verification: the browser's real Codex plan and session/turn/model metadata survived a service restart. Vite 8 constructs the replacement server before closing the prior server; browser service initialization is now lazy, and shutdown callers share one drain promise. A source-change hot restart completed successfully without a database-lock conflict. The persisted real plan remains unapproved for inspection.

## Approved implementation increment

Passed **64 default tests**, TypeScript checks, the production service/UI build, and the offline locked Rust compile check. Default tests make no model calls. Added coverage includes exact approval before any worktree, dirty-main preservation, concurrent isolated branches, branch collisions, forbidden workspace roots, protected path/digest checks, cancellation, global two-worker scheduling with priority aging, validation failure/timeout/staleness, interrupted implementation/validation recovery, missing worktrees, credential-safe stdout/stderr streaming, and OS-released service ownership after an actual process crash.

The opt-in `npm run test:implementation` completed with real Codex CLI **0.153.4**:

1. The planner inspected disposable fixture source and produced an immutable proposal. No implementation worktree existed before its exact approval.
2. Approval dispatched an implementer in a separate branch/worktree. Only `greeting.cjs` changed; the authoritative test fixture remained byte-for-byte unchanged.
3. The service committed the real diff and ran the configured Node assertions using Codex `command/exec` with workspace-write/no-network policy. Checks passed for the exact recorded HEAD. Credential-like test output was redacted before persistence.
4. The main checkout’s source, dirty file, branch, and HEAD remained unchanged.
5. Sandbox probes allowed writes inside the worktree and denied both a write to the main checkout and an HTTP request to a live temporary endpoint (zero requests received).
6. Cancellation interrupted a running validation process and its descendant; a delayed descendant write did not occur.
7. Reopening and reconciling the data preserved `CODE_REVIEW` and the exact worktree/commit evidence. No final approval, merge, or deployment occurred.

The completed disposable run was also opened through the browser development bridge with its explicit data/workspace roots. Project trust/enable/check configuration rendered correctly; task detail showed its isolated path/branch, base/current commit, one-file diff, passing exit code, and redacted captured log. The UI continues to show independent review and final acceptance as pending. The normal `.factory/browser/` dataset was not modified by this fixture inspection.

Native visual interaction and signed/self-contained packaging remain open. Production execution of unknown/untrusted scripts, automatic dependency installation, unrestricted network access, automatic repair, independent review, final acceptance, and post-acceptance cleanup are not claimed by this milestone.

## Independent review and final acceptance increment

Milestone 4 adds a separate read-only Codex reviewer, structured exact-commit findings, up to three persisted repairs per approved plan, fresh validation/review after each repair, immutable final evidence, and exact-artifact human decisions. Production TypeScript/service compilation and Vue typechecking/build passed. **89 default regression tests passed.** They cover final acceptance and invalidation, blocked/contradictory reviews, repair exhaustion across restart, human-requested changes, source mutation during review, cancelled review/repair, orphaned stage recovery, legacy code-review continuation, and read-only reviewer protocol enforcement. No default tests call a model.

Two real-provider smoke runs used Codex CLI **0.153.4** and its catalog default `gpt-6-astra`. The complete repair run is retained at `.factory/build-smoke-1795553862309/`:

1. Real plan → explicit exact-plan approval → isolated implementation → commit → sandboxed checks → independent review → `FINAL_REVIEW`.
2. A disposable human-requested change asked for a short comment documenting the approved optional formal parameter. A fresh repair session changed only `greeting.cjs`, committed a new HEAD, passed the authoritative unchanged tests, and received a passing review in a second independent session.
3. New checks, review, and evidence matched the repaired commit `79d735f04590d3cd44596914f97519847780afa4`. The earlier review became stale. A final decision naming the wrong HEAD was rejected.
4. Exact-commit acceptance succeeded and survived service restart. The main checkout's HEAD, original source, and dirty file remained unchanged. No merge, push, or deployment occurred.
5. Workspace-write sandbox probes again allowed task-worktree writes and denied main-checkout writes and network requests. Validation cancellation stopped a child and descendant; no delayed descendant write appeared. Credential-like output was redacted.

Before API acceptance, the smoke test preserved a disposable database copy at `ui-preview/factory.db` for UI verification. Browser development was launched against that copy and the existing disposable worktree root. The Final Review screen showed implementation/repair limitations, full one-file diff, the repaired SHA, passing exit code and redacted log, current/superseded reviews, evidence digest, and final decision controls. Controls stayed disabled until clean-worktree inspection completed. After entering fixture feedback and clicking **Accept reviewed commit**, the UI showed `Accepted`, `Accepted change`, zero attention items, and a durable `final · Accept` decision with the supplied feedback. This was a disposable test decision; normal browser/desktop datasets were not changed.

Screenshot of the verified decision gate: [final-review-gate.png](final-review-gate.png). The screenshot was captured immediately before fixture acceptance and includes the reviewed diff, enabled final controls, and current independent review. It is not a native Tauri window screenshot. Native visual lifecycle verification, signed/self-contained packaging, request editing/archiving, and explicit worktree cleanup remain open.

## Daily-use request management, diagnostics, and native package

Passed **97 default tests**, production service compilation/Vue typechecking/build, and a release Rust/Tauri build with `--locked --offline`. The focused eight-operation test suite also passed after the final restore CLI fix. Added cases cover immutable edits, stale versions, archive/restore restrictions, original task scope/approval preservation, revised requests, report privacy, online backup consistency, non-overwriting restore, future-schema rejection, and migration 5 → 6 with original task inputs retained.

The final Apple Silicon macOS package includes Node **22.12.0**, its matching native SQLite addon, compiled service/contracts, runtime dependencies/licenses, the offline restore tool, and a **914-file SHA-256 resource manifest**. The generated app is approximately 133 MiB; its ZIP is approximately 40 MiB. `codesign --verify --deep --strict` passed for the app and its relocated copy. The ZIP checksum is recorded in `release/release.json` and the adjacent `.sha256` file.

The final `npm run test:package` passed from a relocated copy at a macOS temporary-directory path, with a clean HOME, PATH limited to `/usr/bin:/bin`, and no repository cwd, external Node/npm, NODE_PATH, or inherited credentials. It verified every resource hash, loaded the native addon, registered a disposable repository, created/edited/archived a request, preserved the task's original request criteria through fake planning, exported privacy-filtered diagnostics, made a consistent backup, shut down/reopened the companion with persisted state and released ownership, and restored using the bundled offline tool. An initial restore CLI check caught `/var` versus `/private/var` entry-path aliasing; comparing real paths fixed it.

Native UI verification used `.factory/native-ui-1795555178936/`, copied from disposable package fixtures. Normal browser/development/release application data was not substituted or migrated. The packaged `.app` launched via macOS Launch Services with PATH restricted to `/usr/bin:/bin`. Through its **private native stdio IPC**, the UI:

- Created a request, saved an edited revision, archived it, selected the archived filter, and restored it.
- Found the installed Codex CLI via native tool discovery, confirmed CLI sign-in, and populated its connection/catalog result without a model inference call.
- Displayed packaged runtime/schema/integrity/storage/worker diagnostics; exported a filtered report and database backup with hashes.
- Restarted the companion through Settings: uptime reset to zero and request state remained intact.
- Closed the window with Cmd-W, exiting the app and companion; `service.lock`, WAL, and SHM were absent afterward.
- Relaunched the final build **without diagnostic mode**, showing the edited/restored request and working diagnostics export, then closed cleanly again.

Native testing initially exposed a blank renderer/CSP eval violation. Frontend schema validation now explicitly uses Zod's interpreter; CSP still excludes unsafe-eval. Final native rendering and interactions were visually verified. Opt-in native diagnostics were used during investigation; the final normal launch does not install the diagnostic console hooks or emit raw renderer diagnostics to support reports.

Screenshots: [native requests](native-requests.png), [native operations](native-operations.png). These are actual packaged Tauri window captures, replacing the earlier browser-only visual verification limit. Native active-worker interruption is covered by the service cancellation/recovery suite; the window-close UI check itself used an idle fixture.

No Developer ID code-signing identity is installed (`security find-identity` found zero valid identities). The delivered app is **ad-hoc signed and locally verified, not notarized**. No notarization upload, installation into Applications, external publication, merge, or deployment occurred. Other CPU architectures/platforms and cross-machine Gatekeeper acceptance are not verified. Richer provider auto-assignment, optional notifications/PR integration, and explicit accepted-worktree cleanup remain separate work.


## Nuxt UI redesign verification

The redesigned renderer uses **Nuxt UI 4.13.1** with its Vue/Vite plugin, Tailwind 4, and locally bundled Lucide icons. The UI remains in the existing Vue/Tauri application; no backend protocol, execution authority, persistence schema, or native CSP was changed.

- **97/97 default tests passed**, covering the existing approval, worktree, validation, review/repair, cancellation/recovery, request-revision, and operational boundaries.
- Production service/renderer builds, Vue/TypeScript checks, and the release Rust/Tauri build passed. The renderer build reports a non-blocking bundle-size warning (about 819 KiB JavaScript / 225 KiB gzip before the separate toast chunk).
- `npm run test:package` passed again with **914 resource hashes**, relocated signature verification, bundled Node **22.12.0**, no external Node, and backup/restore/persistence checks.
- Browser interaction checks against the disposable `build-smoke-1795553862309/ui-preview` database exercised request creation, edited title persistence, archive/archived-filter/restore, task creation, explicit simulation planning, plan navigation, list/board switching, command search via Cmd-K, diagnostics loading, light appearance, and accepted-status filtering. No model inference was needed. Browser console inspection returned no warnings or errors.
- The rebuilt `.app` launched with PATH limited to `/usr/bin:/bin`, without native diagnostic mode, using an online backup in `.factory/ui-refresh-native-1795576336723/` and the original disposable worktree root. It rendered its own bundled assets through strict native CSP and private IPC. Cmd-K searched and opened the actual earlier Codex-reviewed fixture; task tabs displayed its clean worktree, current SHA, checks, colored diff, independent review, and exact evidence digest. Cmd-W closed the application. No normal user dataset was replaced.
- Native screenshots: [overview](screenshots/ui-refresh-native.png), [plan](screenshots/ui-refresh-plan.png), and [worktree diff](screenshots/ui-refresh-changes.png). The simulation fixture is visibly identified. The accepted greeting fixture contains the real Codex implementation/repair/review evidence from the prior milestone.

The refreshed ZIP remains locally ad-hoc signed and verified, without notarization. Its current checksum is recorded in `release/release.json` and the adjacent SHA-256 sidecar.
