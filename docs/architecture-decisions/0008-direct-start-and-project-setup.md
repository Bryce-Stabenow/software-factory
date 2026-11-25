# 0008 — Direct request start and guided project setup

Status: accepted

## Context

Saving a request previously required separate task creation and planner assignment before any progress. Project registration ended before checks/permissions were configured, and validation commands required raw JSON editing.

## Decision

Make Save for later and Start task distinct request actions. Starting saves the request, then invokes a transactional request.startTask command with the expected request version and optional planner and per-stage model overrides. The command creates a task or reuses its existing INBOX task and queues planning; archived, stale, or already-started inputs are rejected. Queue failures roll back task creation. If saving succeeded but starting failed, the editor retains the saved request identity for retry. Tasks continue to capture immutable request inputs.

Open project settings after registration and expose the same form on existing projects. Planning-only setup and deferral are supported. Trust and implementation are never enabled by onboarding automatically. Present checks as named commands and timeouts, with suggestions and explanatory help. An argument tokenizer supports quoting but never invokes a shell; backend argv validation and sandboxing remain unchanged.

## Consequences

Starting a task authorizes read-only planning, not implementation. Exact plan approval, configured execution permission, validation/review evidence, and final acceptance gates remain in place. No database migration is required. Existing configuration round-trips through the command editor, including quoted paths and literal arguments. The setup form requires at least one check to enable implementation while preserving the service's explicit NOT RUN behavior for older configurations.

## Agent defaults and project settings

Project settings use exactly three tabs: Computer permissions & defaults, Worktree initialization, and Verification commands. One draft and one Save project settings action cover all tabs. Validation opens the affected panel and focuses the invalid field. Repository network requests remain beside initialization commands; local network permission stays with computer permissions.

New projects use Codex with catalog-default planning, implementation, and review models. The default planner and all three model choices are persisted locally in project config_json. Commands remain in .kulumin.yml. Changing only defaults preserves YAML text and verification evidence.

Request starts (including saved requests) and INBOX assignments resolve omitted fields from project defaults. Explicit null means catalog default; an explicit model ID overrides the project. Resolved choices and requestVersion are captured in provider_policy_json at assignment and survive later project edits, clarification, replanning, recovery, and repeated review. Planning uses planningModel, implementation and repair use implementationModel, and independent review uses reviewModel. Initialization and verification do not use these selections.

Planning retry accepts only planningModel: omission retains the captured choice, null resets to catalog default, and an ID replaces it. Actual model reporting remains on each agent run. Catalog default resolves at stage execution time. Missing catalog entries and catalog failures retain selected IDs; they never silently substitute models. Simulation still cannot authorize real execution.

The shared model command and policy field is replaced directly. Existing development data is not migrated or normalized.
