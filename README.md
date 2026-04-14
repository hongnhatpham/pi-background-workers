# Pi Subagent Orchestrator Extension

A Pi extension for observable delegation.

The core idea is simple:

- **ARIA-03 stays the primary counterpart**
- **subagents do bounded task work**
- **all delegation is visible**
- **future Quickshell UI can observe the same task graph**

## Opinionated stance

This project is not about turning conversation into tool soup.
It is about preserving one continuous relationship while letting work fan out when needed.

So the architecture should treat:

- the main assistant as the continuity holder
- subagents as disposable task workers
- delegation as a tree with explicit parentage
- visibility as a first-class requirement, not a later add-on

## What this should eventually do

- delegate tasks to fresh subagents
- optionally allow **bounded nested delegation**
- keep a live task graph with parent/child relationships
- surface status in Pi footer + commands
- persist task/event state to disk for external observers
- later feed a Quickshell panel showing task threads and progress

## Key design decisions

### 1. One relationship, many workers
The user talks to ARIA-03.
Subagents report to ARIA-03, not directly as peer selves.

### 2. Nested delegation is allowed, but bounded
Useful sometimes, dangerous by default.
Recommended policy:

- allow nesting only when a parent task clearly benefits from fan-out
- cap depth at 2 or 3
- cap active children per node
- require the parent to summarize what it learned back up the tree

### 3. Visibility is mandatory
Every delegated task should be observable with:

- task id
- parent id
- title
- state
- assigned agent
- cwd
- timestamps
- progress note / latest event
- children

### 4. External UI should read state, not scrape text
The future Quickshell panel should read a structured state file or event stream.
That means this extension should maintain a stable on-disk representation from the start.

## Repo structure

```text
pi-subagent-orchestrator-extension/
  README.md
  package.json
  tsconfig.json
  docs/
    architecture.md
  src/
    index.ts
    schema.ts
    task-store.ts
```

## Current scaffold

The current scaffold includes:

- task/event schema
- observable task store with JSON snapshot + event log persistence
- real subprocess worker execution through Pi JSON mode
- Pi footer status
- a delegated worker tool:
  - `delegate_task`
- commands:
  - `/delegate-status`
  - `/delegate-log`
  - `/delegate-clear`
  - `/delegate-run <task>`
  - `/delegate-demo`

Workers now run with bounded toolsets by mode, can optionally read memory for context, and are blocked from modifying MemPalace or soul files.

## Why a Pi extension?

Yes — I think this should be a Pi extension first.

Reason:
- it lives closest to agent lifecycle and session context
- it can register tools/commands and footer status
- it can later bridge to SDK/subprocess workers
- it can expose stable structured state for a custom interface

For real worker execution, we can choose between:
- **subprocess `pi` workers** first, borrowing from Pi's subagent example
- **SDK-managed sessions** later if we want finer control

Current recommendation and status:
- v1: subprocess workers + observable task graph ✅
- v2: richer orchestration, scheduling, and Quickshell UI
