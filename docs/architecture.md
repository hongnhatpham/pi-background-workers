# Architecture

## Core model

There are three layers:

1. **Primary assistant layer**
   - holds continuity
   - owns relationship with the user
   - decides when delegation is warranted

2. **Subagent execution layer**
   - runs bounded work
   - may optionally spawn child tasks if policy allows
   - reports upward, not outward

3. **Observation layer**
   - records task state and event stream
   - feeds Pi footer/commands now
   - feeds Quickshell panel later

## Delegation tree

Each task belongs to a tree.

- root task: owned by ARIA-03 / current user request
- child task: delegated by a parent task
- grandchild task: allowed only if policy permits nested delegation

Important:
- parent/child links must always be explicit
- the system should be able to reconstruct the whole tree from persisted state

## Policy recommendation

Default conservative policy:

- `maxDepth = 2`
- `maxChildrenPerTask = 4`
- `allowNestedDelegation = true`
- nested delegation only for research, fan-out discovery, or decomposition-heavy work

Why not unlimited recursion?
Because it quickly becomes opaque, expensive, and narratively incoherent.

## Visibility contract

Each task should expose at least:

- `id`
- `parentId`
- `title`
- `status`
- `agent`
- `cwd`
- `createdAt`
- `updatedAt`
- `latestNote`
- `depth`

Each event should expose:

- `taskId`
- `at`
- `kind`
- `message`
- optional payload

## Persistence

The extension should write two artifacts:

1. **snapshot JSON**
   - latest whole task graph
   - easy for Quickshell or other clients to read

2. **event JSONL**
   - append-only activity log
   - useful for debugging and replay

Recommended location:

```text
~/.local/state/pi-subagent-orchestrator/
  tasks.json
  events.jsonl
```

## UI plan

### Pi TUI now

- footer status via `ctx.ui.setStatus()`
- `/delegate-status` for compact tree
- `/delegate-log` for recent events

### Quickshell later

The panel should not parse terminal text.
It should read `tasks.json` or subscribe to a lightweight bridge that uses the same underlying state.

That gives us:
- persistent task list
- parent/child thread view
- active/running indicators
- later: pause/cancel/retry actions

## Implementation path

### v1
- observable task store
- status + commands
- disk persistence
- real subprocess worker execution
- reduced tool access per task mode
- read-only memory access allowed
- worker guard blocking memory writes and soul-file changes

### v2
- richer structured progress updates from workers
- explicit nested delegation policy and better parent/child execution flows
- cancellations, retries, queueing

### v3
- scheduled/proactive orchestration
- Quickshell panel
- prioritization and broader life/work automation
