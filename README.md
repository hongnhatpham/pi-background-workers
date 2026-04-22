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
- small Pi-native command and tool surface

## Current contents

- `docs/ARCHITECTURE.md` — design for the clean-room v0
- `docs/IMPLEMENTATION.md` — ordered implementation checklist for v0

## Planned v0

- `delegate_task` tool
- `/bg`, `/bg-list`, `/bg-show`, `/bg-cancel`, `/bg-results`
- background Pi worker launcher
- task snapshot + event log persistence
- generic worker prompt
- reload-safe state reconstruction

## Repo reset note

This repository previously contained an unfinished delegation prototype.
That code has been intentionally removed from the working tree so the new system can be designed and implemented from first principles.
