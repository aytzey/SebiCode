import type { PRDTask } from './types.js'

export function buildReviewPrompt(task: PRDTask, diffOutput: string): string {
  return `Review this diff for task "${task.title}" (${task.id}).

## Acceptance Criteria
${task.acceptanceChecks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Owned Paths: ${task.ownedPaths.map(p => `\`${p}\``).join(', ')}

## Diff
\`\`\`diff
${diffOutput}
\`\`\`

Focus on: logic, security, acceptance criteria.
Do NOT flag: style, build errors, missing tests (unless in criteria).

If good: VERDICT: APPROVED
If issues:
VERDICT: NEEDS_FIX
ISSUES:
- [issue]
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
  return `Reviewer found issues with "${task.title}".

## Feedback
${reviewFeedback}

## Owned Paths: ${task.ownedPaths.map(p => `\`${p}\``).join(', ')}

Fix ONLY the identified issues. Stay within owned paths. Commit the fix.`
}
