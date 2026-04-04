import type { SebiRalphRunLookup, SebiRalphRunState } from './types.js'

export function normalizeSebiRalphTaskText(userTask: string): string {
  return userTask.trim().replace(/\s+/g, ' ')
}

export function selectReusableSebiRalphRun(
  lookups: SebiRalphRunLookup[],
  options: {
    userTask: string
    launchMode: SebiRalphRunState['launchMode']
    currentSessionId: string
  },
): SebiRalphRunLookup | null {
  const expectedTask = normalizeSebiRalphTaskText(options.userTask)
  const matches = lookups.filter(lookup => {
    const run = lookup.run
    return (
      run.launchMode === options.launchMode &&
      normalizeSebiRalphTaskText(run.userTask) === expectedTask
    )
  })

  if (matches.length === 0) {
    return null
  }

  const statusRank = (status: SebiRalphRunState['status']): number => {
    switch (status) {
      case 'active':
        return 0
      case 'awaiting_user':
        return 1
      case 'blocked':
        return 2
      case 'completed':
        return 3
    }
  }

  const sortMatches = (candidates: SebiRalphRunLookup[]): SebiRalphRunLookup =>
    [...candidates].sort((a, b) => {
      const sameSessionA = a.run.sessionId === options.currentSessionId ? 0 : 1
      const sameSessionB = b.run.sessionId === options.currentSessionId ? 0 : 1
      if (sameSessionA !== sameSessionB) {
        return sameSessionA - sameSessionB
      }

    const statusA = statusRank(a.run.status)
    const statusB = statusRank(b.run.status)
    if (statusA !== statusB) {
      return statusA - statusB
    }

      return b.run.updatedAt.localeCompare(a.run.updatedAt)
    })[0]!

  const incompleteMatches = matches.filter(lookup => lookup.run.status !== 'completed')
  if (incompleteMatches.length > 0) {
    return sortMatches(incompleteMatches)
  }

  if (options.launchMode === 'loop') {
    return sortMatches(matches)
  }

  return null
}
