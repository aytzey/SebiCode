# SebiRalph Harness Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform `/sebiralph` from a prompt-only skill into a structured 8-phase harness flow with multi-provider swarm.

**Architecture:** Rewrite `orchestrator.ts` to build a structured prompt that inlines content from all sebiralph modules. Rewrite `index.ts` to import all modules and set up effort/config. The prompt follows the `batch` skill's pattern: phased markdown with Agent tool templates.

**Tech Stack:** TypeScript, Claude Code bundled skill API

---

### Task 1: Rewrite `orchestrator.ts` — 8-phase harness prompt builder

**Files:**
- Rewrite: `source/src/skills/sebiralph/orchestrator.ts`

- [ ] **Step 1: Write the new orchestrator**

Complete rewrite of `buildOrchestratorPrompt()`. The function imports and inlines content from all modules to produce a structured 8-phase prompt. Each phase includes: header, instructions, tool call template, exit criteria, error handling.

Key imports to inline:
- `PLAN_JSON_SCHEMA_PROMPT` from prd.ts
- `HARD_GATES` from planner.ts
- `buildPlannerPrompt()` signature for Phase 2 template
- `buildEvaluatorPrompt()` signature for Phase 3 template
- Gate commands from gates.ts (as bash command templates)
- Git commands from integration.ts (as bash command templates)

- [ ] **Step 2: Verify imports resolve**

Run: `cd /home/dkmserver/Desktop/Machinity/aytug/sebi-code && node -e "require('./source/src/skills/sebiralph/orchestrator.ts')"` or check TypeScript compilation.

- [ ] **Step 3: Commit**

```bash
git add source/src/skills/sebiralph/orchestrator.ts
git commit -m "feat(sebiralph): rewrite orchestrator as 8-phase harness flow"
```

### Task 2: Rewrite `index.ts` — skill registration with all modules

**Files:**
- Rewrite: `source/src/skills/sebiralph/index.ts`

- [ ] **Step 1: Write the new index**

Import all modules. Build config phase at invocation time. Set `effort: 'max'`. Generate the full harness prompt using `buildOrchestratorPrompt()`.

- [ ] **Step 2: Verify skill registration**

Check that the skill registers correctly and all imports resolve.

- [ ] **Step 3: Commit**

```bash
git add source/src/skills/sebiralph/index.ts
git commit -m "feat(sebiralph): wire all modules into skill registration"
```
