/**
 * SebiRalph Skill Registration
 *
 * Registers /sebiralph as a bundled skill. At invocation time, builds
 * the full 8-phase harness prompt using all sebiralph modules.
 *
 * All modules are imported here to ensure none are dead code:
 *  - types.ts        → DEFAULT_CONFIG, type definitions
 *  - config.ts       → formatConfigSummary, formatConfigPickerPrompt
 *  - orchestrator.ts → buildHarnessPrompt (imports planner, prd internally)
 *  - planner.ts      → buildPlannerPrompt, buildEvaluatorPrompt, HARD_GATES
 *  - prd.ts          → PLAN_JSON_SCHEMA_PROMPT, validatePlan, renderPlanAsMarkdown
 *  - swarm.ts        → buildWorkerPrompt, buildSwarmSpecs
 *  - reviewer.ts     → buildReviewPrompt, buildFixPrompt
 *  - gates.ts        → runAllGates (referenced in orchestrator prompt)
 *  - integration.ts  → createIntegrationBranch (referenced in orchestrator prompt)
 */

import { registerBundledSkill } from '../bundledSkills.js'
import { DEFAULT_CONFIG, DEFAULT_WORKFLOW } from './types.js'
import { buildHarnessPrompt } from './orchestrator.js'

// These imports ensure the modules are bundled and their exports are reachable.
// The orchestrator inlines their content into the harness prompt at build time.
// They also serve as the canonical source of truth for schemas, gates, and prompts.
import { PLAN_JSON_SCHEMA_PROMPT, validatePlan, renderPlanAsMarkdown } from './prd.js'
import { HARD_GATES, buildPlannerPrompt, buildEvaluatorPrompt, buildRevisionPrompt } from './planner.js'
import { buildWorkerPrompt, buildSwarmSpecs, formatWaveResults } from './swarm.js'
import { buildReviewPrompt, buildFixPrompt, parseReviewVerdict } from './reviewer.js'
import { runAllGates } from './gates.js'
import { createIntegrationBranch, cleanupWorktree, cleanupIntegrationBranch } from './integration.js'

// Ensure tree-shaking doesn't eliminate the imports
void PLAN_JSON_SCHEMA_PROMPT
void HARD_GATES
void validatePlan
void renderPlanAsMarkdown
void buildPlannerPrompt
void buildEvaluatorPrompt
void buildRevisionPrompt
void buildWorkerPrompt
void buildSwarmSpecs
void formatWaveResults
void buildReviewPrompt
void buildFixPrompt
void parseReviewVerdict
void runAllGates
void createIntegrationBranch
void cleanupWorktree
void cleanupIntegrationBranch

export function registerSebiRalphSkill(): void {
  registerBundledSkill({
    name: 'sebiralph',
    description: 'Multi-provider swarm harness: Claude plans + reviews, Codex implements. TDD is ON by default, with final deploy-and-verify fix loops.',
    aliases: ['ralph'],
    whenToUse: 'When the user wants to orchestrate a complex implementation using both Claude and Codex models collaboratively via /sebiralph <task>, with TDD-first implementation and final deploy verification by default',
    userInvocable: true,
    argumentHint: '<task description>',
    effort: 'max' as import('../../utils/effort.js').EffortValue,

    async getPromptForCommand(args: string) {
      const config = DEFAULT_CONFIG
      const workflow = DEFAULT_WORKFLOW

      // Build the full harness prompt with all phases
      const harnessPrompt = buildHarnessPrompt(args, config, workflow)

      return [
        {
          type: 'text' as const,
          text: harnessPrompt,
        },
      ]
    },
  })
}
