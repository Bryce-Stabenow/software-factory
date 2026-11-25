# ADR 0001: Private stdio for desktop commands

Status: accepted for the development foundation.

The Tauri Rust host launches one Node companion and owns its stdin/stdout pipes. Vue calls a single typed `factory_command` invocation. Rust serializes command requests through a mutex, writes one JSON line, and reads one response line. The Node service validates every command with shared Zod schemas. UI code cannot directly open SQLite or set task statuses.

This avoids a listening HTTP port, browser-origin authentication, persistent shared secrets, and credentials in renderer storage. The service inherits only an explicit environment allowlist. The renderer has no shell or filesystem plugin permission. This implementation assumes only the bundled local renderer is trusted to invoke commands; repository and request content is displayed as escaped text, not HTML.

Activity uses ordered database events. A snapshot includes an event cursor; the UI polls `events.list` and refreshes the canonical snapshot when it sees new events. Polling is sufficient without streaming agent output in this increment. A future streaming transport must retain the same cursor semantics and apply backpressure. Large diffs/logs should become referenced artifacts, not huge JSON lines.

For browser-only development, a Vite middleware calls the same dispatcher. It checks the exact loopback host, same-origin Origin when supplied, and a non-simple custom header; cross-origin preflights are denied. This is a local development bridge, not the production desktop transport. It uses a separate database to avoid competing ownership.

On window/app exit, Rust drops stdin and waits up to five seconds for Node to close its DB and release its lock, then terminates it if needed. A PID lock prevents two service owners of one data directory. Recovery never converts interrupted runs into success. The lock is local development scaffolding; robust OS-level advisory locking and provider process-tree recovery should precede real workers.

Limitations: requests are serialized; a synchronous slow command can delay other commands. Real agent work must be dispatched asynchronously by the persisted scheduler, with only short commands on this channel. A source-checkout Node executable is used initially; a signed bundled sidecar is an unresolved packaging spike. No promise of packaged app portability is made.

Update for real planning: long provider runs execute as asynchronous persisted jobs. Commands return after enqueueing, and progress is delivered through the replayable event log. See ADR 0003.

Update for implementation: ADR 0004 adds bounded worktree workers and sandboxed validation. Service ownership is now an OS-backed exclusive SQLite lock rather than PID-file arbitration alone; the PID sentinel remains a legacy guard and diagnostic.
