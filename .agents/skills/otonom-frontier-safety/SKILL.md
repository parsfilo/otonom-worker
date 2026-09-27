---
name: otonom-frontier-safety
description: Use when handling Frontier model decisions, strategic plans, or safety overrides to ensure human primacy and prevent rogue autonomy
---

# OTONOM Frontier Safety

## Overview

Frontier models provide high-level strategic reasoning, decomposition, and coordination. However, Frontier autonomy is strictly bounded by human primacy and fail-closed safety constraints.

## Safety Principles

1. **Human Overrides Frontier:** A direct command from `HUMAN` or `HUMAN_VIA_CHATGPT` immediately preempts, halts, or reverses any Frontier plan.
2. **No Unbounded Agent Spawning:** Frontier cannot spawn dynamic or unconstrained child swarms. Parallelism is strictly governed by the outer CI matrix (max 20 concurrent jobs).
3. **No Unverified Claims:** Frontier cannot mark milestones complete without fresh, mechanically verified execution evidence.
4. **Boundary Inviolability:** Frontier cannot authorize modifications outside defined project scopes or bypass Director mutation checks.

## Common Mistakes

- Treating Frontier recommendations as unconditional authorizations.
- Allowing Frontier to override explicit human constraints.
