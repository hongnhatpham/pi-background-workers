# pi-background-workers Architecture

Status: draft v0

## Why this exists

Pi is good at doing focused work, but the default interaction model is still too blocking.
When a task turns into a long implementation, audit, crawl, or research run, the main conversation effectively disappears until that run finishes.

That is the wrong shape for the way I am supposed to work for you.
The main assistant should remain your conversational front desk while bounded workers do background execution.

This package exists to make that pattern first-class.

## Core thesis

There should be **one primary assistant relationship** and **many disposable workers**.

- You talk to the main assistant.
- The main assistant decides when work should be delegated.
- Workers execute bounded tasks in isolated Pi processes.
- Workers report back through persisted state and final summaries.
- The main assistant stays available for new requests while background work continues.

This is the practical Pi analogue of Claude Code's `/btw` feeling.
Not by magically interrupting an already-blocking turn, but by making long work leave the foreground quickly.

## Design goals

1. Keep the main conversation available while delegated work runs.
2. Make delegation visible, inspectable, and cancellable.
3. Prefer a generic worker over a zoo of roleplayed subagents.
4. Keep the implementation small, honest, and Pi-native.
5. Persist enough state for future UI layers and post-hoc inspection.
6. Support tool-driven delegation from the main assistant.
7. Avoid turning every request into orchestration theater.

## Non-goals for v0

These are explicitly out of scope for the first clean-room version:

- persistent long-lived worker sessions
- arbitrary nested delegation trees
- worker-to-worker conversations
- Quickshell UI integration
- rich TUI dashboards
- automatic worker memory writes
- multi-user coordination
- cross-machine scheduling
- mid-stream interruption of an already-running foreground LLM turn
- predefined theatrical persona agents as the default workflow

## What was wrong with the previous attempt

The old subagent/delegation work failed mainly because it optimized for the wrong abstraction.

It behaved like a structured batch runner:

- spawn child Pi process
- wait for completion
- collect output
- return as one blocking tool result

That can be useful, but it does **not** create the feeling of an always-available primary assistant.
It also pushed too much complexity into role selection and orchestration shape instead of solving the core problem: background execution with clean visibility.

This design is a clean-room reset.

## Product shape

The package should eventually ship as `pi-background-workers`.

The package provides:

- a background task registry
- one single-worker model tool: `delegate_task`
- one multi-worker model tool: `delegate_swarm`
- a small command surface for the user
- worker process launching and supervision
- persistent task snapshots and event logs
- light footer/status integration

## Mental model

There are three layers.

### 1. Main assistant layer

This is the assistant you are talking to.
It owns:

- conversation continuity
- user trust
- delegation decisions
- synthesis of worker results

### 2. Worker execution layer

Each worker is:

- a fresh Pi subprocess
- isolated from the parent context window
- given a bounded prompt and task contract
- allowed to use normal tools unless restricted by policy
- expected to produce compact structured output

### 3. Observation layer

This layer records what happened so the main assistant and later UIs can inspect it.
It owns:

- task metadata
- status changes
- progress notes
- final summaries
- logs and exit state

## Key design decision: background-first, not subagent-first

The most important choice is that delegation must be **background-first**.

If the main assistant calls `delegate_task`, the expected result is:

1. a worker is launched
2. task metadata is persisted
3. control returns quickly to the main conversation
4. the worker continues independently
5. the main assistant can inspect results later

That means `delegate_task` is not primarily a "run another model and wait" tool.
It is a **launch-and-track** tool.

Synchronous waiting can exist later as an option, but it should not be the default mental model.

## Worker model

### Worker type

v0 uses a **generic worker** prompt by default.

Reason:

- most tasks do not need fake specialist cosplay
- generic workers reduce prompt surface and coordination overhead
- specialization can be layered in later only where it clearly helps

### Worker invocation

Each worker will be launched as a separate Pi process in JSON mode.

Conceptually:

```bash
pi --mode json -p --no-session [worker options...]
```

The exact flags may evolve, but the important invariant is:

- isolated process
- machine-readable output stream
- no shared conversational session with the parent

### Worker contract

Each worker receives:

- task id
- title
- cwd
- objective
- bounded instructions
- output format requirements
- optional model override
- optional tool restrictions

Each worker must end with a compact final report shaped for handoff to the main assistant.

## User-facing commands

v0 command surface should stay small.

### `/bg <task>`

Launch a generic background worker for the current cwd.

Examples:

```text
/bg audit why the dev server keeps serving stale css
/bg trace the mcp config loading path and summarize failure modes
```

### `/bg-swarm <task one || task two || ...>`

Launch a small background swarm from the command line. The `||` separator keeps the v0 command parser simple while allowing explicit fan-out.

Examples:

```text
/bg-swarm inspect current worker runtime || review prompt policy || check tests for brittle assumptions
```

### `/bg-show-swarm <swarm-id>`

Show grouped task state for a swarm: counts, roles, latest notes, and compact result summaries.

### `/bg-cancel-swarm <swarm-id>`

Cancel all queued/running tasks in a swarm while preserving partial finished results. This is executor-owned cancellation; higher-level ARIA swarm commands should route live cancellation here.

### `/bg-list`

Show active and recent tasks.

### `/bg-show <id>`

Show task details, recent progress notes, current status, and final summary if available.

### `/bg-cancel <id>`

Request cancellation of a running worker.

### `/bg-results <id>`

Render the worker's final result in a compact handoff-friendly format.

### Optional aliases

These may exist as user-friendly aliases, but they are not core to the architecture:

- `/delegate`
- `/background`
- `/btw`

My preference is to standardize on `/bg*` internally and add aliases later.

## Model-facing tool

### `delegate_task`

This launches one background worker.

Its job is to create a background task, not to narrate delegation theatrically.

#### Required fields

- `task`: the worker objective

#### Optional fields

- `title`
- `cwd`
- `model`
- `tools`
- `priority`
- `timeoutMinutes`
- `waitForResult` (default `false`)

#### Returns

At minimum:

- task id
- title
- status
- cwd
- launchedAt
- how to inspect it later

If `waitForResult: true` is ever allowed, the tool may optionally block until completion, but that is explicitly not the default v0 flow.

### `delegate_swarm`

This is the preferred model tool when a request has independent strands that can run at the same time.

Examples:

- scout relevant code paths + review current tests
- frontend slice + backend slice + docs slice
- implementation worker + independent reviewer
- multiple repository search areas

#### Required fields

- `tasks`: array of bounded worker objectives

#### Optional shared fields

- `objective`
- `cwd`
- `model`
- `tools`
- `priority`
- `timeoutMinutes`
- `waitForResults` (default `false`, ignored in v0)

Each task may also include `title`, `role`, `taskType`, `roleHint`, `parentTaskId`, `cancellationGroup`, `acceptanceCriteria`, `expectedArtifacts`, `riskLevel`, `cwd`, `model`, `tools`, `priority`, and `timeoutMinutes`.

The runtime still enforces the global concurrency cap, so a swarm can queue excess tasks instead of launching an unbounded number of Pi processes.

## Delegation-first model behavior

The extension does two things to make the main assistant use delegation more often:

1. It appends turn-specific swarm policy to the system prompt, including an assessment of whether the current user request is explicit, swarm-worthy, task-worthy, or not worth delegating.
2. It applies a one-shot tool-call nudge before local-only work when delegation is clearly expected.

The nudge is intentionally bounded:

- explicit delegation, swarm, fan-out, or background-worker requests block the first non-delegation tool call and instruct the model to launch `delegate_swarm` or `delegate_task` first
- swarm-worthy requests block the first mutating/expensive local tool (`bash`, `edit`, or `write`) before a delegation tool has been used
- task-worthy requests only nudge before `edit` or `write`
- the nudge fires at most once per turn and is skipped once `delegate_task` or `delegate_swarm` has been called
- users can still opt out by saying not to delegate, and operators can disable the guardrail with `PI_BACKGROUND_WORKERS_DELEGATION_NUDGE=0`

This is meant to be a behavioral affordance, not an autopilot. The main assistant remains responsible for deciding when coordination overhead is larger than the benefit.

## Status model

Each task should have a simple lifecycle.

```text
queued -> running -> succeeded
                 -> failed
                 -> cancelled
```

Optional transitional states:

- `cancelling`
- `timed_out`

v0 should avoid a more complicated state machine unless real pressure appears.

## Persistence model

The package should persist state outside the active conversation.
This is necessary for:

- reload safety
- crash recovery
- inspection from later sessions
- future external UI integration

### Proposed storage root

```text
~/.local/state/pi-background-workers/
```

### Proposed structure

```text
~/.local/state/pi-background-workers/
  tasks.json
  events.jsonl
  tasks/
    <task-id>/
      meta.json
      stdout.jsonl
      stderr.log
      result.json
```

### Artifact responsibilities

#### `tasks.json`

Latest snapshot of all known tasks.
Fast to read for commands and footer state.

#### `events.jsonl`

Append-only event stream for auditability and future observers.

#### `tasks/<task-id>/meta.json`

Task-local snapshot with status, timestamps, pid, cwd, model, and summary fields.

#### `tasks/<task-id>/stdout.jsonl`

Machine-readable worker event stream as captured from child Pi JSON mode.

#### `tasks/<task-id>/stderr.log`

Raw stderr from worker process.

#### `tasks/<task-id>/result.json`

Normalized final handoff result.

## Event model

Every task should emit coarse-grained lifecycle events.

Recommended event kinds:

- `task.created`
- `task.started`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.cancel_requested`
- `task.cancelled`
- `task.timeout`

v0 should favor useful coarse events over over-instrumentation.

## Progress reporting

The worker should not spam the observation layer with every token.
That creates noise and bloats state.

Instead, progress should be sampled or promoted from meaningful milestones:

- process started
- major step reached
- tool-heavy phase entered
- summary updated
- result finalized

The main assistant does not need the entire transcript to stay useful.
It needs enough signal to answer:

- Is the task alive?
- What is it doing?
- Is it stuck?
- What came out of it?

## BTW interaction model

This architecture is meant to create the *effect* of `/btw` without pretending Pi has magical concurrent foreground input.

### Important honesty

If the main assistant is already blocked inside one long foreground turn, Pi does not suddenly become interruptible by wishful thinking.

So v0 solves the problem differently:

- long work should be delegated early
- delegated work runs in the background
- the main conversation becomes free again quickly
- you keep talking to the main assistant normally

That is the correct practical design.

## Worker prompt shape

The default worker prompt should be plain and disciplined.

Principles:

- no persona theater
- no fake specialist ego unless requested
- do the task directly
- summarize clearly
- list files changed when relevant
- surface blockers and uncertainty

Recommended output sections:

```text
## Done
## Files Changed
## Notes
```

## Tool policy

v0 should not aggressively over-constrain workers, but it should support policy hooks.

Possible future controls:

- allowed tools whitelist
- dangerous tool confirmation rules
- per-task cwd restrictions
- max runtime
- max concurrent workers

For v0, the default should be:

- inherit normal tool availability
- run in a specified cwd
- enforce a timeout
- enforce a global concurrency cap

## Concurrency model

The system should support multiple background workers, but not unbounded fan-out.

Recommended v0 defaults:

- max concurrent workers: 3
- max swarm size: 8 tasks
- min swarm size: 2 tasks; use `delegate_task` or `/bg` for a single strand
- queue excess tasks instead of launching all at once
- simple FIFO scheduling is acceptable

This is enough to be useful without becoming a homebrew distributed system.

## Cancellation model

Cancellation should be best-effort and explicit.

Flow:

1. user or main assistant requests cancellation
2. task marked `cancelling`
3. child process receives termination signal
4. final status becomes `cancelled` if process exits accordingly

If the process ignores termination, v0 may escalate after a grace period.

## Failure model

A task can fail because of:

- Pi process launch failure
- invalid cwd
- provider/model failure
- tool failure cascade
- timeout
- process crash
- malformed JSON output

The registry must still preserve a usable final record with:

- status
- error summary
- stderr path
- partial output if available

## Session integration

The extension should rebuild in-memory state from disk on `session_start`.
It should clean up timers and subscriptions on `session_shutdown`.

It should also expose lightweight footer status, for example:

- number of running workers
- queued workers
- recently completed workers

No elaborate dashboard is required for v0.

## Main assistant behavior policy

The main assistant should delegate more readily than a stock coding assistant when there is clear leverage, such as:

- long-running implementation
- parallelizable research
- broad auditing
- noisy repository inspection
- repetitive mechanical edits

The main assistant should not delegate reflexively for tiny tasks.

Rule of thumb:

- use `delegate_swarm` for independent strands that can run in parallel
- use `delegate_task` for one long/noisy strand
- stay local for judgment, conversation, synthesis, and tiny tasks

## Security and trust

Because workers are just Pi subprocesses, they inherit real machine access.
That means this package should remain conservative about:

- project-local custom worker prompts
- automatic code execution in untrusted repos
- silent escalation of tool access

If project-scoped worker profiles are ever supported, they should require explicit trust.

## Future phases

### v0

- generic background workers
- `delegate_task`
- `/bg`, `/bg-list`, `/bg-show`, `/bg-cancel`, `/bg-results`
- snapshot + JSONL persistence
- simple concurrency cap
- timeout + cancellation
- reload-safe state reconstruction

### v1

- optional typed worker profiles
- better footer/status rendering
- result adoption into conversation helpers
- improved progress extraction
- limited nested delegation if truly justified

### v2+

- external observers
- Quickshell integration
- richer task graph UI
- worker retry policies
- cross-session orchestration ergonomics

## Hard boundaries

These are deliberate design constraints.

1. The main assistant remains the relationship holder.
2. Workers are disposable and subordinate.
3. Background execution matters more than roleplay.
4. Observability is mandatory.
5. v0 stays small.
6. No pretending that blocked foreground turns are interruptible when they are not.

## Recommended immediate build plan

1. Create a docs-first repo reset.
2. Implement task registry and persistence layer.
3. Implement worker launcher and supervisor.
4. Expose `/bg*` commands.
5. Expose `delegate_task` to the model.
6. Dogfood locally with real Pi sessions.
7. Only then decide whether aliases like `/btw` are worth adding.

## Open questions

1. Should the eventual package keep the repo name or be renamed to match `pi-background-workers`?
2. Should `delegate_task` allow synchronous `waitForResult` in v0, or should that wait until v1?
3. Should worker tool access default to full current-session tools or a smaller curated default set?
4. Should completed task summaries be auto-injected back into the main session, or only shown on demand?

## Recommendation

For v0:

- rename the conceptual product to `pi-background-workers`
- keep a generic worker only
- no nested delegation in v0
- no fancy UI yet
- use background launch as the default behavior
- make the main assistant proactively delegate when a task obviously benefits
