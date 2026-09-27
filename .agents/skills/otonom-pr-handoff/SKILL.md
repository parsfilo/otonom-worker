---
name: otonom-pr-handoff
description: Use when transitioning completed local lane changes to the trusted finalizer for review, branch creation, and PR handoff
---

# OTONOM PR Handoff

## Overview

The PR Handoff marks the boundary where the untrusted worker finishes its local job and hands control to the trusted finalizer.

## Handoff Checklist

Before calling `complete_lane`:
- [ ] Code changes made exclusively within `allowed_write_paths`.
- [ ] Zero unrequested modifications to locks, configs, or other lanes' files.
- [ ] Fresh verification executed via `run_verification` with exit code 0.
- [ ] Zero lingering compiler errors or linter warnings.
- [ ] Any architectural findings recorded via `record_finding`.
- [ ] Any required out-of-scope needs recorded via `cross_lane_request`.

## Execution

Call `complete_lane` tool.
If the tool confirms `{ completed: true }`, terminate the agent session cleanly.
The finalizer will automatically take over commit, branch creation, and PR submission.

## Common Mistakes

- Attempting to run `git commit` or `git push` manually before handoff.
- Failing to verify that all tests pass prior to invoking handoff.
