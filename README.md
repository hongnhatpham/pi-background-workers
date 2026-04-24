# pi-background-workers

Clean-room reset for Pi background delegation.

## Status

Architecture-first rewrite in progress.

The previous subagent/delegation iteration is being discarded because it solved the wrong problem.
It behaved like a blocking batch runner, not like an always-available primary assistant with bounded background workers.

This repo is now the clean-room home for a new design:

- one primary assistant relationship
- disposable background workers
- quick return to the main conversation
- persistent task visibility
- visible launch/completion announcements so delegated work is never silent
- completion reports steer the active agent turn when work finishes mid-response, but only trigger a follow-up turn when Pi is idle
- a first-class worker swarm path for launching several bounded background tasks in one model tool call
- grouped swarm completion summaries so related workers report back as one coherent event instead of per-worker noise
- session-owned completion delivery so multiple Pi sessions can inspect shared worker state without stealing each other's completion pings
- delegation-first prompt policy plus a one-shot tool-call nudge so explicit swarm/delegation requests do not silently fall back to local-only work
- small Pi-native command and tool surface

## Current contents

- `docs/ARCHITECTURE.md` — design for the clean-room v0
- `docs/IMPLEMENTATION.md` — ordered implementation checklist for v0

## Planned v0

- `delegate_task` tool for one background worker
- `delegate_swarm` tool for 2-8 related background workers
- `/bg`, `/bg-swarm`, `/bg-list`, `/bg-show`, `/bg-show-swarm`, `/bg-cancel`, `/bg-cancel-swarm`, `/bg-results`
- background Pi worker launcher
- task snapshot + event log persistence
- generic worker prompt with optional swarm contract metadata: id, role, task type, acceptance criteria, expected artifacts, risk, and cancellation group
- reload-safe state reconstruction
- launch visibility for `/bg`, `/bg-swarm`, `delegate_task`, and `delegate_swarm`: status text, UI notification, and displayed transcript message
- `/bg-list`, `/bg-show`, and `/bg-results` render into the transcript instead of leaving a stale persistent bottom widget
- finished worker reports use active-turn steering while the assistant is working, and idle follow-up only after the assistant has finished; swarm-tagged workers use one grouped completion report with an explicit review/adoption boundary
- new tasks are stamped with the launching Pi session id/file, so auto-completion reports are delivered only in that owner session; legacy unowned tasks remain reportable for backward compatibility
- explicit delegation/swarm requests trigger a one-shot delegation-first nudge if the assistant tries to use a non-delegation tool before `delegate_task` or `delegate_swarm`; set `PI_BACKGROUND_WORKERS_DELEGATION_NUDGE=0` to disable that guardrail

## Repo reset note

This repository previously contained an unfinished delegation prototype.
That code has been intentionally removed from the working tree so the new system can be designed and implemented from first principles.
