import { describe, expect, test } from 'bun:test'
import { ownedPathsOverlap, validatePlan } from './prd.js'
import type { RalphPlan } from './types.js'

function makePlan(overrides: Partial<RalphPlan> = {}): RalphPlan {
  return {
    title: 'Test plan',
    summary: 'Test summary',
    tasks: [
      {
        id: 't1',
        title: 'Task 1',
        description: 'Task 1 description',
        role: 'worker',
        modelRef: { provider: 'openai', model: 'gpt-5.4' },
        ownedPaths: ['src/lib/auth.ts'],
        dependsOn: [],
        inputs: [],
        outputs: [],
        acceptanceChecks: ['Add auth regression test coverage'],
        wave: 0,
        status: 'pending',
      },
      {
        id: 't2',
        title: 'Task 2',
        description: 'Task 2 description',
        role: 'worker',
        modelRef: { provider: 'openai', model: 'gpt-5.4' },
        ownedPaths: ['src/lib/auth.tsx'],
        dependsOn: [],
        inputs: [],
        outputs: [],
        acceptanceChecks: ['Add auth component spec coverage'],
        wave: 0,
        status: 'pending',
      },
    ],
    waves: [
      {
        wave: 0,
        type: 'contracts',
        taskIds: ['t1', 't2'],
      },
    ],
    sharedContracts: {},
    ...overrides,
  }
}

describe('ownedPathsOverlap', () => {
  test('matches exact paths and real directory nesting only', () => {
    expect(ownedPathsOverlap('src/api/routes.ts', 'src/api/routes.ts')).toBe(true)
    expect(ownedPathsOverlap('src/api', 'src/api/routes.ts')).toBe(true)
    expect(ownedPathsOverlap('src/api/', 'src/api/v1/route.ts')).toBe(true)
    expect(ownedPathsOverlap('./src/api', 'src/api/routes.ts')).toBe(true)
  })

  test('does not treat filename prefixes as overlaps', () => {
    expect(ownedPathsOverlap('src/lib/auth.ts', 'src/lib/auth.tsx')).toBe(false)
    expect(ownedPathsOverlap('src/foo', 'src/foobar')).toBe(false)
    expect(ownedPathsOverlap('src/api-client', 'src/api')).toBe(false)
  })
})

describe('validatePlan', () => {
  test('does not report false overlap errors for sibling file paths', () => {
    const result = validatePlan(makePlan())

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('allows concrete non-test acceptance checks for bounded tasks', () => {
    const result = validatePlan(
      makePlan({
        tasks: [
          {
            ...makePlan().tasks[0]!,
            acceptanceChecks: ['`npm run build` succeeds for auth changes'],
          },
          makePlan().tasks[1]!,
        ],
      }),
    )

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('still reports true overlap errors for nested owned paths', () => {
    const result = validatePlan(
      makePlan({
        tasks: [
          {
            ...makePlan().tasks[0]!,
            ownedPaths: ['src/components/editor'],
          },
          {
            ...makePlan().tasks[1]!,
            ownedPaths: ['src/components/editor/toolbar.tsx'],
          },
        ],
      }),
    )

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(
      'Wave 0: path `src/components/editor/toolbar.tsx` (t2) overlaps with `src/components/editor` (t1)',
    )
  })
})
