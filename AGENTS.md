# Universal Swarm Worker Rules

This repository (`parsfilo/otonom-worker`) is a temporary, high-throughput GitHub Actions agent harness.

## Universal Operating Directives

1. **Public Repository Threat Model:**
   - All console logs, workflow output, and telemetry emitted by runner steps are considered public information.
   - NEVER print private source code, raw git diffs, environment dumps, or credential values to standard output.
   - Write diagnostic and telemetry details exclusively to `$RUNNER_TEMP/otonom-private/<lane>/`.

2. **Task Contract Primacy:**
   - Execute strictly within the assigned task contract (`task.json`).
   - Read structured boundaries via the `task_context` tool at session startup.
   - Do not add unrequested abstractions, boilerplate, or speculative files.

3. **Ownership Boundary:**
   - Edit ONLY files matching `allowed_write_paths`.
   - Editing files outside your ownership triggers `OUT_OF_SCOPE_WRITE` and fails the lane.
   - If changes are needed in another lane's files, submit a `cross_lane_request`.

4. **No Remote Git or GitHub Writes:**
   - OpenCode agents have ZERO GitHub write credentials.
   - `git push`, `gh pr create`, `gh auth`, `sudo`, and `ssh` are strictly forbidden and blocked.
   - The trusted post-agent finalizer owns all branch creation, commits, and PR submissions.

5. **Mechanical Verification Before Completion:**
   - Model claims of completion without fresh verification evidence are invalid.
   - Run verification via `run_verification` and assert exit code 0 before calling `complete_lane`.
   - The session cannot be completed by prose assertions alone.

6. **Load Skills on Demand:**
   - Consult relevant skills under `.agents/skills/` (e.g. `otonom-task-contract`, `otonom-authority-model`, `test-driven-development`) rather than guessing system invariants.
