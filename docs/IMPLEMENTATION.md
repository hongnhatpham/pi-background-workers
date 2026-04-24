# pi-background-workers Implementation Plan

Status: active working plan for v0

This document turns `docs/ARCHITECTURE.md` into an execution checklist.
We should implement against this file in order, updating task status as work lands so we do not lose the thread.

---

## Working rules

1. Keep v0 minimal.
2. Prefer one generic worker path over multiple specialized abstractions.
3. Do not add nested delegation in v0.
4. Do not add rich UI before the core runtime is solid.
5. Every completed task should leave the repo in a runnable, dogfoodable state.
6. Update this document as tasks are completed or scope changes.

---

## v0 target

By the end of v0, the package should support:

- launching background Pi workers
- tracking their lifecycle on disk
- inspecting tasks later from Pi commands
- cancelling running tasks
- returning normalized final results
- exposing `delegate_task` and `delegate_swarm` tools for the main assistant

Not required for v0:

- nested delegation
- rich dashboards
- external UI integrations
- persistent worker conversations
- specialized agent catalogs

---

## Phase 0 — Repo scaffolding

### Goals

Create the minimum package structure needed to start implementing safely.

### Tasks

- [x] Add `tsconfig.json`
- [ ] Add `package-lock.json` via `npm install`
- [x] Add `src/` directory
- [x] Add `test/` directory
- [x] Expand `package.json` with scripts:
  - [x] `build` or `typecheck`
  - [x] `test`
  - [x] `check`
- [x] Add any minimal test dependencies
- [x] Update `README.md` to mention implementation plan once this file exists

### Acceptance criteria

- repo installs cleanly with `npm install`
- `npm run check` works
- empty implementation skeleton can typecheck

---

## Phase 1 — Core types and storage layout

### Goals

Define the data model before launching any workers.

### Tasks

- [x] Add `src/types.ts`
- [x] Define task status enum/type:
  - [x] `queued`
  - [x] `running`
  - [x] `succeeded`
  - [x] `failed`
  - [x] `cancelled`
  - [x] optional `cancelling`
  - [x] optional `timed_out`
- [x] Define task metadata type
- [x] Define normalized task result type
- [x] Define event record type
- [x] Define config/defaults type
- [x] Add `src/paths.ts`
- [x] Implement state root resolution:
  - [x] `~/.local/state/pi-background-workers/`
- [x] Define canonical file layout helpers for:
  - [x] `tasks.json`
  - [x] `events.jsonl`
  - [x] `tasks/<id>/meta.json`
  - [x] `tasks/<id>/stdout.jsonl`
  - [x] `tasks/<id>/stderr.log`
  - [x] `tasks/<id>/result.json`

### Acceptance criteria

- storage paths are centralized
- file layout is deterministic
- types cover the whole planned lifecycle

---

## Phase 2 — Persistence layer

### Goals

Create a small storage API that owns all reads and writes.

### Tasks

- [x] Add `src/store.ts`
- [x] Implement:
  - [x] `createTask()`
  - [x] `updateTask()`
  - [x] `appendEvent()`
  - [x] `listTasks()`
  - [x] `getTask()`
  - [x] `writeResult()`
  - [x] `appendWorkerStdoutEvent()`
  - [x] `appendWorkerStderr()`
- [x] Keep `tasks.json` in sync with task-local `meta.json`
- [x] Make writes resilient to missing directories
- [x] Ensure state can be reconstructed purely from disk
- [x] Add tests for storage behavior

### Acceptance criteria

- a task can be created, updated, listed, and reloaded from disk
- result and event files are written to the correct locations
- tests cover happy-path storage flows

---

## Phase 3 — Worker prompt contract

### Goals

Define one generic worker prompt and one output contract.

### Tasks

- [x] Add `src/worker-prompt.ts`
- [x] Define the generic worker instructions
- [x] Include required final output sections:
  - [x] `## Done`
  - [x] `## Files Changed`
  - [x] `## Notes`
- [x] Define how task metadata is embedded into the worker prompt
- [x] Decide whether prompt is inline or temp-file based
- [x] Add tests for prompt generation if helpful

### Acceptance criteria

- worker prompt is deterministic
- output contract is explicit
- no specialist-role framework is required for v0

---

## Phase 4 — Worker launcher and supervisor

### Goals

Run a Pi subprocess in the background and supervise its lifecycle.

### Tasks

- [x] Add `src/worker-runner.ts`
- [x] Add Pi invocation helper for child workers
- [x] Launch Pi in JSON mode with isolated execution
- [x] Stream stdout lines and parse JSON events when possible
- [x] Capture stderr to file
- [x] Record process metadata:
  - [x] pid
  - [x] startedAt
  - [x] finishedAt
  - [x] exitCode
- [x] Promote task status transitions:
  - [x] `queued -> running`
  - [x] `running -> succeeded|failed|cancelled|timed_out`
- [x] Normalize final result into `result.json`
- [x] Add timeout handling
- [x] Add cancellation handling
- [x] Add concurrency cap support
- [x] Add tests for runner helpers where feasible

### Acceptance criteria

- a worker can launch and finish without blocking the parent runtime
- stdout/stderr are persisted
- final status is correct for success/failure/timeout/cancel cases

---

## Phase 5 — Runtime manager

### Goals

Coordinate multiple tasks from the extension runtime.

### Tasks

- [x] Add `src/runtime.ts`
- [x] Track in-memory running processes
- [x] Rebuild state from disk on `session_start`
- [x] Clean up timers/subscriptions on `session_shutdown`
- [x] Reconcile tasks whose process exited while Pi was reloading
- [x] Implement basic queueing when concurrency limit is reached
- [x] Provide helpers for:
  - [x] launch task
  - [x] cancel task
  - [x] inspect task
  - [x] list active/recent tasks

### Acceptance criteria

- reload does not destroy task visibility
- running/recent tasks remain inspectable across sessions
- queued tasks can progress when capacity frees up

---

## Phase 6 — Pi commands

### Goals

Expose background work controls to the user.

### Tasks

- [x] Add `src/index.ts`
- [x] Register `/bg`
- [x] Register `/bg-swarm`
- [x] Register `/bg-list`
- [x] Register `/bg-show`
- [x] Register `/bg-cancel`
- [x] Register `/bg-show-swarm`
- [x] Register `/bg-cancel-swarm`
- [x] Register `/bg-results`
- [x] Add compact human-readable rendering for each command
- [x] Add footer/status summary if cheap and stable

### Command expectations

#### `/bg <task>`

- creates a task
- launches now if capacity exists, otherwise queues
- returns task id and current status

#### `/bg-swarm <task one || task two || ...>`

- creates multiple related tasks with a shared swarm id
- launches up to the runtime concurrency cap and queues the rest
- returns one visible transcript launch message for the whole swarm

#### `/bg-list`

- shows running tasks first
- then queued
- then recent finished tasks

#### `/bg-show <id>`

- shows metadata, recent progress, and status

#### `/bg-cancel <id>`

- requests cancellation
- reports whether cancellation was accepted

#### `/bg-show-swarm <swarm-id>`

- renders grouped swarm task status and compact result summaries

#### `/bg-cancel-swarm <swarm-id>`

- requests cancellation for queued/running tasks in the swarm
- preserves partial finished results

#### `/bg-results <id>`

- renders final normalized result if task is finished

### Acceptance criteria

- all commands work in a real Pi session
- command output is understandable without reading JSON files manually

---

## Phase 7 — Model tool

### Goals

Let the main assistant delegate work programmatically.

### Tasks

- [x] Register `delegate_task`
- [x] Register `delegate_swarm`
- [x] Define input schema:
  - [x] `task`
  - [x] optional `title`
  - [x] optional `cwd`
  - [x] optional `model`
  - [x] optional `timeoutMinutes`
  - [x] optional `tools`
  - [x] optional `priority`
  - [x] optional `waitForResult` (disabled/ignored in v0)
- [x] Tool should create and launch a background task
- [x] Tool should return quickly by default
- [x] Tool result should include task id + inspection hints
- [x] `delegate_swarm` should accept 2-8 bounded worker objectives and stamp them with a shared swarm id
- [x] Add delegation-first prompt policy for explicit/swarm-worthy user requests
- [x] Add one-shot tool-call nudge so explicit delegation requests do not silently proceed with local-only tools
- [ ] Add tool rendering if useful

### Acceptance criteria

- main assistant can launch background work without monopolizing the conversation
- main assistant can fan out independent strands in one tool call
- tool behavior is background-first by default
- explicit delegation/swarm requests are actively nudged toward `delegate_swarm`/`delegate_task` before unrelated local tools

---

## Phase 8 — Dogfooding and validation

### Goals

Use the package on real work before adding more features.

### Tasks

- [ ] Install package into local Pi setup
- [ ] Test simple research task
- [ ] Test simple implementation task
- [ ] Test timeout path
- [ ] Test cancellation path
- [ ] Test multiple concurrent tasks
- [ ] Test reload while workers are running
- [ ] Test result inspection from a fresh session
- [x] Record observed rough edges in this document or README

### Acceptance criteria

- at least 3 real tasks complete successfully
- cancellation and reload behavior are acceptable
- package feels meaningfully closer to a `/btw` workflow

---

## Observed rough edges so far

- Worker completion originally required manual polling; this is now addressed with automatic completion handoff messages.
- Worker output quality can still be poor even on successful runs; result validation now marks malformed reports and surfaces validation issues, but the worker prompt likely needs further hardening during dogfooding.
- The main assistant previously underused delegation; the extension now injects stronger per-turn swarm guidance for foreground sessions, explicit launch-shape suggestions, and exposes `delegate_swarm` plus `/swarm`/`/delegate` aliases for cheap fan-out.
- Background worker child sessions explicitly do not receive the foreground swarm policy injection, preventing recursive delegation pressure inside disposable workers.
- Existing finished tasks with `reportedAt: null` may be reported once after reload, which is acceptable for now but not yet polished.

---

## Phase 9 — Nice-to-have only after v0 works

These should stay deferred unless v0 is already solid.

- [ ] aliases like `/delegate` or `/btw`
- [ ] better footer/status widgets
- [x] automatic notifications when tasks finish
- [ ] richer progress extraction from worker streams
- [ ] optional worker profiles
- [ ] external observer API
- [ ] Quickshell integration

---

## Suggested file plan

Initial likely file set:

- `src/index.ts`
- `src/types.ts`
- `src/paths.ts`
- `src/store.ts`
- `src/runtime.ts`
- `src/worker-prompt.ts`
- `src/worker-runner.ts`
- `src/utils.ts`
- `test/store.test.ts`
- `test/paths.test.ts`
- `test/worker-prompt.test.ts`

This can change, but should remain small.

---

## Current recommended execution order

1. Phase 0 — scaffolding
2. Phase 1 — core types and storage layout
3. Phase 2 — persistence layer
4. Phase 3 — worker prompt contract
5. Phase 4 — worker launcher and supervisor
6. Phase 5 — runtime manager
7. Phase 6 — commands
8. Phase 7 — model tool
9. Phase 8 — dogfooding

---

## Definition of done for v0

v0 is done when all of the following are true:

- I can launch a background task from Pi
- I can keep talking in the main conversation afterward
- I can inspect task state later
- I can cancel a running task
- I can retrieve a final result cleanly
- the main assistant can delegate with `delegate_task` and fan out with `delegate_swarm`
- reloads do not destroy visibility into running/recent tasks

---

## Immediate next task

Start with:

- [x] Phase 0 — Repo scaffolding
- [x] Phase 1 — Core types and storage layout
- [x] Phase 2 — Persistence layer

Those three phases create the foundation for everything else.
