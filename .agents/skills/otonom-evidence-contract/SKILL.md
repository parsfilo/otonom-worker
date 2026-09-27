---
name: otonom-evidence-contract
description: Use when capturing test run outputs, exit codes, and verifiable proof of task completion in OTONOM
---

# OTONOM Evidence Contract

## Overview

In OTONOM, claims of completion without fresh verification evidence are invalid. The Evidence Contract governs how verification runs and structured results are recorded.

## Evidence Requirements

1. **Fresh Execution:** Evidence must come from execution in the current session. Cached or historical results do not count.
2. **Mechanical Metrics:** Capture command name, exit code, test pass/fail counts, and duration.
3. **Structured Format:** Save evidence to `evidence.json` and summary to `result.json`.
4. **No Raw Source In Logs:** Public evidence contains only sanitized metadata counts.

## Schema Highlights

```json
{
  "task_id": "webhook-durability",
  "status": "PASS",
  "verification_results": [
    {
      "profile": "lane",
      "command": "pnpm test:webhooks",
      "exit_code": 0,
      "passed": true,
      "duration_ms": 1420
    }
  ],
  "test_summary": {
    "total": 12,
    "passed": 12,
    "failed": 0,
    "skipped": 0
  }
}
```

## Common Mistakes

- Writing "all tests pass" in chat without running `run_verification`.
- Altering test assertions to force green output without fixing root causes.
