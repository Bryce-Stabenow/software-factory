# ADR 0006: Request history, operations, and self-contained macOS packaging

Status: implemented for local Apple Silicon macOS use. Developer ID notarization remains a separate distribution step.

## Immutable task inputs

Migration 6 adds immutable request revisions and backfills existing request records. Request updates, archive, and restore are version checked and transactional with their revision and event. Archiving is reversible organization: it does not cancel work or alter approvals. Archived requests cannot create tasks or be edited until restored.

A task retains the request revision captured at creation. Planning, implementation, review, scheduling priority, and task detail read that revision, including the original project, text, and acceptance criteria. Inbox edits can therefore never silently broaden an authorized task. The UI explains this distinction and offers Create revised request, which copies the latest request into a separate identity with its own future task and approval. Request revisions are not deleted or rewritten.

## Operational reports and backups

Diagnostics are built from an explicit allowlist: application/runtime/schema versions, database integrity and storage metrics, task/run counts, heartbeat age, provider connection booleans, and bounded normalized error-code counts. Reports exclude request/project names, paths, source, diff, raw provider messages, command arguments, logs, account identities, environment values, and credentials. Exports are created in the app-owned exports folder with private permissions and a content SHA-256.

Database backups use SQLite's online backup API, not a raw copy of a live WAL database. They preserve full private request/evidence data, so the UI distinguishes them from support reports. Shutdown drains outstanding backups before closing SQLite. Backups do not copy external worktree/repository files. Offline restore verifies integrity, foreign keys, and supported schema, takes service ownership, refuses to overwrite any database state, restores into a new directory, and runs migrations. Existing worktree references retain their original locations. Restore ships both as a source command and a bundled Node CLI.

## Native runtime and lifecycle

Release builds resolve the companion relative to the app's resource directory. They bundle a standalone Node executable, compiled service/contracts, the matching native SQLite addon, required runtime packages, licenses, and a SHA-256 resource manifest. Node/addon architectures and system-library dependencies are checked during preparation. The app does not need the repository checkout, npm, or separately installed Node. Git, Codex, and project-specific check dependencies remain local prerequisites.

Release data defaults to Tauri's application data directory, independent of checkout and app location. Release launches do not seed demo projects or enable execution. Existing development data remains in its original location; an explicit backup/restore is available. A data-dir override supports recovery and disposable testing. Finder launches discover common local tool locations, including Homebrew and nvm bins, without executing a user's login shell or forwarding arbitrary environment variables.

Native commands run through a serialized stdio worker outside the UI thread. Responses have size/time bounds; failures leave a visible restart path. Explicit Restart service closes the old companion before starting another and triggers normal persisted recovery. Window close and quit drain the companion, release ownership, and exit the app. A bounded forced-stop fallback preserves interrupted work for recovery rather than claiming completion. Renderer startup errors can be inspected through opt-in FACTORY_NATIVE_DEBUG; raw renderer diagnostics are never included in support reports. Native CSP retains no unsafe-eval: frontend Zod uses its interpreter.

## Packaging and signing boundary

The reproducible local pipeline compiles service/UI/Rust offline with locked Rust dependencies, stages runtime resources, checks native loading, builds the app, signs nested native code and then the app, verifies the full signature, and creates a ZIP and checksum manifest. It explicitly avoids automatic notarization or upload.

Without an installed Developer ID identity, the result uses a verified ad-hoc signature suitable for this local build. An optional APPLE_SIGNING_IDENTITY supports local Developer ID signing, but notarization and cross-machine Gatekeeper acceptance are not claimed. Only the build-machine architecture is packaged; Intel/universal and other operating systems are not verified.

References: [Tauri resources](https://v2.tauri.app/develop/resources/), [macOS bundles](https://v2.tauri.app/distribute/macos-application-bundle/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/).
