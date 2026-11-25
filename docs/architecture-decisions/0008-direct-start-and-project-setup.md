# 0008 — Direct request start and guided project setup

Status: accepted

## Context

Saving a request previously required separate task creation and planner assignment before any progress. Project registration ended before checks/permissions were configured, and validation commands required raw JSON editing.

## Decision

Make Save for later and Start task distinct request actions. Starting saves the request, then invokes a transactional request.startTask command with the expected request version and explicit provider/model. The command creates a task or reuses its existing INBOX task and queues planning; archived, stale, or already-started inputs are rejected. Queue failures roll back task creation. If saving succeeded but starting failed, the editor retains the saved request identity for retry. Tasks continue to capture immutable request inputs.

Open project settings after registration and expose the same form on existing projects. Planning-only setup and deferral are supported. Trust and implementation are never enabled by onboarding automatically. Present checks as named commands and timeouts, with suggestions and explanatory help. An argument tokenizer supports quoting but never invokes a shell; backend argv validation and sandboxing remain unchanged.

## Consequences

Starting a task authorizes read-only planning, not implementation. Exact plan approval, configured execution permission, validation/review evidence, and final acceptance gates remain in place. No database migration is required. Existing configuration round-trips through the command editor, including quoted paths and literal arguments. The setup form requires at least one check to enable implementation while preserving the service's explicit NOT RUN behavior for older configurations.
