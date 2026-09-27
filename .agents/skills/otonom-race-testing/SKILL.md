---
name: otonom-race-testing
description: Use when authoring concurrency regression tests, stress-testing optimistic locks, or validating race condition defenses in OTONOM
---

# OTONOM Race Condition Testing

## Overview

Race conditions cannot be caught by single-threaded sequential tests. Concurrency testing in OTONOM requires parallel stress harnesses that fire simultaneous operations against the same entity.

## Testing Pattern

1. **Setup:** Initialize state with known base revision.
2. **Parallel Dispatch:** Use `Promise.all` or worker threads to dispatch N concurrent mutation requests with the same base revision simultaneously.
3. **Assert Invariants:**
   - Exactly ONE operation must succeed (return 200 / commit).
   - Exactly N - 1 operations must fail closed with `OptimisticConcurrencyError` or conflict code.
   - Entity final revision must equal `base_revision + 1`.
   - Entity state must remain completely consistent.

## Example Test

```typescript
test("concurrent mutations on same entity: exactly 1 succeeds, others conflict", async () => {
  const entityId = await createTestEntity({ value: 100, revision: 1 });
  const concurrency = 20;

  const results = await Promise.allSettled(
    Array.from({ length: concurrency }).map((_, i) =>
      mutateEntity(entityId, { value: 100 + i, baseRevision: 1 })
    )
  );

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(concurrency - 1);

  const finalEntity = await getEntity(entityId);
  expect(finalEntity.revision).toBe(2);
});
```

## Common Mistakes

- Using `for...of` loops with `await` (runs sequentially, hiding races).
- Relying on `setTimeout` to simulate concurrency instead of genuine parallel promises.
