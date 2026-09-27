---
name: otonom-director-mutations
description: Use when writing, modifying, or testing state mutation handlers, revision locking, or transaction gates managed by the Director
---

# OTONOM Director Mutations

## Overview

The Director is the exclusive gatekeeper for state mutations in OTONOM. Every change to canonical state must pass Director inspection, authority validation, and revision check.

## Mutation Lifecycle

1. **Request:** Worker or Frontier submits a MutationRequest containing `authority`, `base_revision`, `target`, and `payload`.
2. **Authority Check:** Director verifies caller has required authority level for the target domain.
3. **Optimistic Concurrency Check:** Director compares `base_revision` against current Brain revision:
   - If `base_revision !== current_revision`: Reject immediately with `STALE_REVISION_ERROR`.
4. **Validation:** Director runs schema and domain integrity invariants.
5. **Commit:** Director increments revision, persists event to Brain ledger, and broadcasts new state.

## Concurrency Pattern

```typescript
async function applyMutation(req: MutationRequest): Promise<MutationResult> {
  return await db.transaction(async (tx) => {
    const current = await tx.getBrainRevision();
    if (current !== req.baseRevision) {
      throw new StaleRevisionError(req.baseRevision, current);
    }
    const nextRevision = current + 1;
    await tx.recordMutationEvent(nextRevision, req);
    await tx.updateBrainState(nextRevision, req.payload);
    return { success: true, revision: nextRevision };
  });
}
```

## Common Mistakes

- Blindly applying updates without checking base revision.
- Allowing background tasks to bypass the Director gate.
