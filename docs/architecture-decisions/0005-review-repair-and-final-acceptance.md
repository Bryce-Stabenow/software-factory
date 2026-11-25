# ADR 0005: Independent review, bounded repairs, and exact-commit acceptance

Status: implemented. Extends ADR 0004's execution boundary through the second human gate.

## Separate review authority

After successful configured checks, start a fresh Codex session with the verified native read-only/no-network policy and disabled shell, plugins, MCP integrations, hooks, and subagents. The reviewer receives only list/read tools over a bounded redacted snapshot, the approved plan, request criteria, complete captured diff, current commit, captured checks, previous findings, and implementation summaries/limitations. Summaries are untrusted evidence. Require actual repository-read activity, structured findings, and the exact commit SHA. No review or repair can manufacture check success.

A missing, oversized, unsafe, or truncated changed-file snapshot blocks review rather than presenting partial evidence as complete. Deleted safe files remain represented in the full diff. Compare both the immutable snapshot digest and worktree HEAD/content fingerprint after review. Mutation, incorrect commit, unsupported permission requests, invalid output, or unavailable provider block publication. A `blocked` verdict preserves findings for human action. A `pass` containing high/critical findings is normalized to changes requested.

## Durable bounded pipeline

Implement, validate, review, and repair have distinct persisted run records. They share the existing two-worker semaphore, ownership/heartbeat, per-task exclusion, cancellation, and shutdown drain. A task retains its worktree and original base through all attempts. Each changed repair receives a service-created commit; fresh checks and a fresh reviewer must run afterward, even if the repair made no changes.

Nonzero checks, timeouts, and actionable reviewer findings trigger repairs within approved scope. Configuration omissions, source mutations, provider failures, policy denials, or explicitly blocked reviews require human recovery. At most **three repair attempts per approved plan** are allowed, counting automatic and human-requested repair runs, including interrupted attempts. The counter is reconstructed from persisted runs and survives restarts. Exhaustion blocks with findings/logs preserved. Explicit implementation recovery retains its separate project-configured attempt limit. No automatic scope expansion or replanning grants execution authority.

Startup interrupts unfinished review/repair runs, reconciles orphaned mutating stages, verifies worktrees and final evidence, and requires explicit inspected recovery. Recovery revalidates and rereviews clean commits without invoking the implementer. Existing Milestone 3 `CODE_REVIEW` tasks have an explicit continue action; migrations never dispatch model calls automatically.

## Final evidence and decisions

Migration 5 adds review status/summary and immutable evidence bundles. A bundle contains the approved plan ID/digest, base/current SHA, worktree fingerprint, full captured changed-file list/diff, required check IDs/config/exit codes/logs, latest independent review, previous findings, implementation/repair summaries and limitations, and human-requested change history. Its canonical digest binds the exact presented contents. Redaction precedes persistence and rendering.

The service reconstructs the bundle from authoritative Git and persisted evidence before `FINAL_REVIEW` and again before a final decision. Every configured check must have its latest successful exact-HEAD/config evidence. The latest review must be a passing independent Codex review of that HEAD and approved plan. Unknown checks, stale IDs, changed logs, new source edits/commits, missing worktrees, and changed project checks invalidate the gate. Immutable historical bundles remain inspectable but cannot authorize new acceptance.

Final decisions require expected task version, bundle ID, digest, and exact HEAD. Accept records a `local-human` decision with the bundle and commit, then records `accepted_commit_sha`. An agent cannot transition directly to accepted without that durable decision. Request changes requires feedback, preserves the decision against the reviewed bundle, consumes the same bounded repair budget, and produces new checks/review/evidence before another decision. Reject requires a reason and preserves artifacts.

Inspection and restart revoke current acceptance when HEAD, source, checks, or evidence changes; the historical human decision is retained. `ACCEPTED` is completion of the task, not a Git merge. There is no push, merge, deployment, or automatic cleanup.

Protocol: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
