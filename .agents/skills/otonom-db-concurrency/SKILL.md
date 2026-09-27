---
name: otonom-db-concurrency
description: Use when writing database transactions, schema migrations, optimistic locking logic, or concurrency controls in OTONOM
---

# OTONOM Database Concurrency

## Overview

High-throughput multi-agent execution generates concurrent state operations. OTONOM relies on transactional guarantees and optimistic locking to prevent data corruption and race conditions.

## Concurrency Invariants

1. **Explicit Transaction Boundaries:** State-changing database queries must be wrapped in transactions.
2. **Revision-Based Optimistic Locking:**
   All core entity records maintain an integer `revision` or `version` column. Updates MUST include `WHERE id = $id AND revision = $expectedRevision`.
3. **Fail Closed on Conflict:** If `affected_rows === 0` during a versioned update, fail with `OPTIMISTIC_CONCURRENCY_CONFLICT`. Never overwrite blindly.
4. **Idempotency Keys:** Mutating database operations must store and verify idempotency keys to ensure retry safety.

## Code Pattern

```sql
-- Versioned atomic update
UPDATE director_state
SET state = $newState, revision = revision + 1, updated_at = NOW()
WHERE id = $stateId AND revision = $expectedRevision;
```

```typescript
const result = await db.query(UPDATE_QUERY, [newState, expectedRev, stateId]);
if (result.rowCount === 0) {
  throw new OptimisticConcurrencyError("Stale revision detected");
}
```

## Common Mistakes

- Performing read-modify-write without version checks.
- Assuming serial execution across independent agent workers.
