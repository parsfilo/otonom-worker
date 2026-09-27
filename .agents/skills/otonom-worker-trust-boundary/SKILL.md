---
name: otonom-worker-trust-boundary
description: Use when designing agent sandboxes, passing data to/from workers, or auditing privilege boundaries between workers and coordinator
---

# OTONOM Worker Trust Boundary

## Overview

OpenCode coding agents are untrusted workers. They are given isolated workspaces and limited local tools to produce code changes and test evidence, but never credentials or write authority over target repositories.

## Trust Invariants

1. **Zero Secret Exposure:** Workers run without GitHub write tokens, Doppler credentials, or cloud access keys.
2. **Untrusted Worker Outputs:** All files produced by workers (code diffs, JSON results, evidence) are treated as untrusted proposals by the coordinator.
3. **Mechanical Verification Before Trust:** The trusted finalizer re-verifies tests, runs secret scans, and validates ownership independently after the worker process terminates.
4. **No Git Push Authority:** Workers cannot execute `git push`, create branches on remote, or create PRs directly.

## Workflow Boundary

```
[Untrusted Worker]
  └─ Writes code locally
  └─ Runs local tests
  └─ Writes result.json + evidence.json
       │ (process terminates)
       ▼
[Trusted Finalizer]
  ├─ Validates result schema
  ├─ Verifies path ownership against git diff
  ├─ Scans for secrets
  ├─ Runs independent acceptance verification
  └─ [Target Token Injected] -> Creates branch -> Pushes -> Opens PR
```

## Common Mistakes

- Passing target repository tokens into worker containers.
- Trusting worker assertions without independent mechanical checks.
