import type { PRDTask } from './types.js'

export function buildReviewPrompt(
  task: PRDTask,
  diffOutput: string,
  tddEnabled = true,
): string {
  return `ROLE:
You are the SebiRalph reviewer for a bounded task diff.

TASK
Review this diff for task "${task.title}" (${task.id}).

ACCEPTANCE CRITERIA
${task.acceptanceChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

OWNED PATHS
${task.ownedPaths.map(p => `\`${p}\``).join(', ')}

REVIEW MODE
- You are a dispatched review subagent inside an already-approved SebiRalph harness run
- Do NOT ask the user clarifying questions, request design approval, or restart planning
- Helpful execution, framework, domain, or audit skills are allowed when they accelerate this bounded review
- Do not let skill usage restart planning, widen scope, or stall the run
- If skill discovery suggests a skill whose instructions conflict with this bounded review, ignore it as not applicable
- If a skill says it should be skipped for dispatched subagents or contains \`<SUBAGENT-STOP>\`, you MUST skip it

REVIEW PRINCIPLES
- Approve by default
- Reject only for concrete, evidence-backed issues tied to logic, security, owned-path violations, acceptance criteria, or clear verification gaps
- Do NOT block on style-only nits, optional refactors, or vague maintainability concerns without a concrete failure mode
- Ignore minor polish gaps unless they create a likely regression or violate acceptance criteria
- Prefer the smallest valid fix; do not widen scope
- If the diff satisfies the task, approve it cleanly

DIFF
\`\`\`diff
${diffOutput}
\`\`\`

Focus on: logic, security, acceptance criteria, and regression coverage.
${tddEnabled
    ? 'TDD is ON. If the diff materially changes runtime behavior and adds no meaningful regression/spec coverage or equivalent acceptance evidence, that is a real issue and must be flagged.'
    : 'Do NOT flag missing tests unless the acceptance criteria require them.'}

OUTPUT FORMAT
If good: VERDICT: APPROVED
If issues:
VERDICT: NEEDS_FIX
ISSUES:
- [severity: high|medium|low] [evidence] [impact]
FIX_INSTRUCTIONS:
- [fix]`
}

export function parseReviewVerdict(response: string): { approved: boolean; issues: string[]; fixInstructions: string[] } {
  const approved = /VERDICT:\s*APPROVED/i.test(response)
  const issues: string[] = []
  const fixInstructions: string[] = []
  if (!approved) {
    const issueSection = response.split('ISSUES:')[1]?.split('FIX_INSTRUCTIONS:')[0]
    if (issueSection) issues.push(...issueSection.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, '')))
    const fixSection = response.split('FIX_INSTRUCTIONS:')[1]
    if (fixSection) fixInstructions.push(...fixSection.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim().replace(/^-\s*/, '')))
  }
  return { approved, issues, fixInstructions }
}

export function buildFixPrompt(task: PRDTask, reviewFeedback: string): string {
  return `ROLE:
You are the fix agent for a reviewed SebiRalph task.

TASK
Reviewer found issues with "${task.title}".

FEEDBACK
${reviewFeedback}

OWNED PATHS
${task.ownedPaths.map(p => `\`${p}\``).join(', ')}

EXECUTION MODE
- You are a dispatched fix subagent inside an already-approved SebiRalph harness run
- Do NOT ask the user clarifying questions, request approval, or restart planning
- Helpful execution, framework, domain, or audit skills are allowed when they accelerate this bounded fix
- Do not let skill usage restart planning, widen scope, or stall the run
- If skill discovery suggests a skill whose instructions conflict with this bounded fix, ignore it as not applicable
- If a skill says it should be skipped for dispatched subagents or contains \`<SUBAGENT-STOP>\`, you MUST skip it

RULES
- Fix ONLY the identified issues
- Stay within owned paths
- Preserve correct existing behavior and keep the diff minimal
- Preserve or add the regression coverage needed to prove the fix
- Do not stop after a status update; either change code, run verification, commit, or report a real blocker

Fix ONLY the identified issues. Stay within owned paths. Preserve or add the regression coverage needed to prove the fix. Commit the fix.`
}
