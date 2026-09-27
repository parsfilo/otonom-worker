---
name: otonom-project-brain
description: Use when reading, updating, reconciling, or recovering the canonical durable state of Project Brain in OTONOM
---

# OTONOM Project Brain

## Overview

Project Brain is the sole canonical source of durable truth in OTONOM. Ephemeral workers, local caches, and agent context memory are temporary and dispensable; Project Brain persists.

## Brain Invariants

1. **Single Source of Truth:** All project decisions, architecture snapshots, active goals, and lane allocations live in Brain.
2. **Append-Only Event Ledger:** State mutations are recorded with monotonic sequence numbers and timestamps.
3. **No Direct Writes:** No component may update Brain storage directly except through Director mutations.
4. **Crash Recovery & Reconciliation:** On startup or network partition recovery, Brain reconstructs current state by replaying verified mutation events from storage.

## Core Pattern

```typescript
// Reading Brain State
const brainState = await brain.getSnapshot();

// Mutation must route through Director
await director.requestMutation({
  authority: AuthorityLevel.WORKER,
  target: "brain.tasks",
  baseRevision: brainState.revision,
  change: { action: "COMPLETE_OBJECTIVE", id: "obj-1" }
});
```

## Common Mistakes

- Maintaining separate durable state outside Brain.
- Attempting to overwrite Brain files directly without Director validation.
