import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_CONFIG, DEFAULT_WORKFLOW } from '../../skills/sebiralph/types.js'
import {
  maybeBuildAutoContinuePrompt,
  maybeBuildSebiRalphAutoContinuePrompt,
} from './autocontinue.js'
import {
  applyRunHydration,
  getPersistedProjectDir,
  syncSebiRalphRunStateFromTranscriptEntry,
} from './liveState.js'
import type { SebiRalphRunState } from './types.js'

function buildRun(overrides: Partial<SebiRalphRunState> = {}): SebiRalphRunState {
  const workflow = {
    ...DEFAULT_WORKFLOW,
  }

  return {
    id: 'run-live',
    sessionId: 'session-live',
    projectPath: '/tmp/sebiralph-live-project',
    userTask: 'Ship the feature',
    createdAt: '2026-04-05T00:00:00.000Z',
    updatedAt: '2026-04-05T00:00:00.000Z',
    launchMode: 'standard',
    config: DEFAULT_CONFIG,
    workflow,
    executionPolicy: {
      fullAuto: true,
      tdd: workflow.tdd,
      deployVerification: workflow.deployVerification,
      loopMode: workflow.loopMode,
      optionalRemotePush: true,
      maxPlanIterations: workflow.maxPlanIterations,
      maxGateFixAttempts: workflow.maxGateFixAttempts,
      maxReviewFixCycles: workflow.maxReviewFixCycles,
      maxDeployFixCycles: workflow.maxDeployFixCycles,
      maxQualityLoops: workflow.maxQualityLoops,
    },
    phase: 'config_review',
    status: 'active',
    taskRecords: [],
    waveRecords: [],
    deploy: {
      status: 'unknown',
      fixCycles: 0,
    },
    qualityLoopsCompleted: 0,
    qualityLoopExtensions: 0,
    ...overrides,
  }
}

describe('sebiralph live state', () => {
  test('applyRunHydration merges phase and deploy updates', () => {
    const run = buildRun()
    const next = applyRunHydration(run, {
      updatedAt: '2026-04-05T00:10:00.000Z',
      phase: 'plan',
      status: 'active',
      lastProgressMarker:
        '<sebiralph-progress run_id="run-live" phase="plan" status="entered" />',
      deploy: {
        status: 'pending',
        target: 'preview',
        updatedAt: '2026-04-05T00:10:00.000Z',
      },
    })

    expect(next.phase).toBe('plan')
    expect(next.status).toBe('active')
    expect(next.updatedAt).toBe('2026-04-05T00:10:00.000Z')
    expect(next.deploy.status).toBe('pending')
    expect(next.deploy.target).toBe('preview')
  })

  test('syncSebiRalphRunStateFromTranscriptEntry updates the persisted run file live', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'sebiralph-live-'))
    const runsDir = join(getPersistedProjectDir(tempProjectPath), 'sebiralph-runs')
    await mkdir(runsDir, { recursive: true })

    const run = buildRun({
      id: 'run-live-sync',
      sessionId: 'session-sync',
      projectPath: tempProjectPath,
    })
    const runPath = join(runsDir, `${run.id}.json`)
    await writeFile(runPath, JSON.stringify(run, null, 2) + '\n', 'utf8')

    try {
      await syncSebiRalphRunStateFromTranscriptEntry({
        type: 'assistant',
        sessionId: 'session-sync',
        cwd: tempProjectPath,
        timestamp: '2026-04-05T00:20:00.000Z',
        message: {
          content:
            '<sebiralph-progress run_id="run-live-sync" phase="plan" status="entered" />\n' +
            '<sebiralph-deploy run_id="run-live-sync" status="pending" target="preview" url="" />',
        },
      })

      const updated = JSON.parse(
        await readFile(runPath, 'utf8'),
      ) as SebiRalphRunState
      expect(updated.phase).toBe('plan')
      expect(updated.status).toBe('active')
      expect(updated.updatedAt).toBe('2026-04-05T00:20:00.000Z')
      expect(updated.deploy.status).toBe('pending')
      expect(updated.deploy.target).toBe('preview')
    } finally {
      await rm(getPersistedProjectDir(tempProjectPath), {
        recursive: true,
        force: true,
      })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildSebiRalphAutoContinuePrompt only triggers for active autonomous phases', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'sebiralph-auto-'))
    const runsDir = join(getPersistedProjectDir(tempProjectPath), 'sebiralph-runs')
    await mkdir(runsDir, { recursive: true })

    const run = buildRun({
      id: 'run-auto',
      sessionId: 'session-auto',
      projectPath: tempProjectPath,
      phase: 'plan',
      status: 'active',
    })
    const runPath = join(runsDir, `${run.id}.json`)
    const transcriptPath = join(
      getPersistedProjectDir(tempProjectPath),
      `${run.sessionId}.jsonl`,
    )
    await writeFile(runPath, JSON.stringify(run, null, 2) + '\n', 'utf8')
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          content: [{ type: 'text', text: 'Revising the plan now.' }],
        },
      }) + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildSebiRalphAutoContinuePrompt(
        tempProjectPath,
        'session-auto',
      )
      expect(prompt).toContain(`run ${run.id}`)
      expect(prompt).toContain('Do not emit another status-only update')

      await writeFile(
        runPath,
        JSON.stringify({
          ...run,
          phase: 'prd_approval',
          status: 'awaiting_user',
        }, null, 2) + '\n',
        'utf8',
      )

      const skipped = await maybeBuildSebiRalphAutoContinuePrompt(
        tempProjectPath,
        'session-auto',
      )
      expect(skipped).toBeNull()
    } finally {
      await rm(getPersistedProjectDir(tempProjectPath), {
        recursive: true,
        force: true,
      })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildSebiRalphAutoContinuePrompt resumes once when an Agent tool result is the latest main transcript entry', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'sebiralph-auto-tail-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const runsDir = join(projectDir, 'sebiralph-runs')
    await mkdir(runsDir, { recursive: true })

    const run = buildRun({
      id: 'run-auto-tail',
      sessionId: 'session-auto-tail',
      projectPath: tempProjectPath,
      phase: 'plan',
      status: 'active',
    })
    const runPath = join(runsDir, `${run.id}.json`)
    const transcriptPath = join(projectDir, `${run.sessionId}.jsonl`)
    await writeFile(runPath, JSON.stringify(run, null, 2) + '\n', 'utf8')
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'tool_use', name: 'Agent' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call_agent' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildSebiRalphAutoContinuePrompt(
        tempProjectPath,
        run.sessionId,
      )
      expect(prompt).toContain(`run ${run.id}`)
    } finally {
      await rm(projectDir, {
        recursive: true,
        force: true,
      })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildSebiRalphAutoContinuePrompt skips an ordinary user tool result without a preceding Agent call', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'sebiralph-auto-user-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const runsDir = join(projectDir, 'sebiralph-runs')
    await mkdir(runsDir, { recursive: true })

    const run = buildRun({
      id: 'run-auto-user',
      sessionId: 'session-auto-user',
      projectPath: tempProjectPath,
      phase: 'plan',
      status: 'active',
    })
    const runPath = join(runsDir, `${run.id}.json`)
    const transcriptPath = join(projectDir, `${run.sessionId}.jsonl`)
    await writeFile(runPath, JSON.stringify(run, null, 2) + '\n', 'utf8')
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'tool_use', name: 'Read' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call_read' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildSebiRalphAutoContinuePrompt(
        tempProjectPath,
        run.sessionId,
      )
      expect(prompt).toBeNull()
    } finally {
      await rm(projectDir, {
        recursive: true,
        force: true,
      })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildSebiRalphAutoContinuePrompt skips when the latest main transcript entry is an assistant tool call', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'sebiralph-auto-tool-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const runsDir = join(projectDir, 'sebiralph-runs')
    await mkdir(runsDir, { recursive: true })

    const run = buildRun({
      id: 'run-auto-tool',
      sessionId: 'session-auto-tool',
      projectPath: tempProjectPath,
      phase: 'plan',
      status: 'active',
    })
    const runPath = join(runsDir, `${run.id}.json`)
    const transcriptPath = join(projectDir, `${run.sessionId}.jsonl`)
    await writeFile(runPath, JSON.stringify(run, null, 2) + '\n', 'utf8')
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          stop_reason: 'end_turn',
          content: [{ type: 'tool_use', name: 'Agent' }],
        },
      }) + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildSebiRalphAutoContinuePrompt(
        tempProjectPath,
        run.sessionId,
      )
      expect(prompt).toBeNull()
    } finally {
      await rm(projectDir, {
        recursive: true,
        force: true,
      })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildAutoContinuePrompt resumes generic status-only planning updates without a SebiRalph run', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'generic-auto-plan-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const transcriptPath = join(projectDir, 'session-generic-plan.jsonl')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          content: [
            {
              type: 'text',
              text:
                'Plan aşamasındayım.\n\nŞu an yaptığım:\n- mevcut editor dosyalarını eşliyorum\n- implementasyon görevlerini çıkarıyorum\n\nBirazdan bunu plan dosyasına yazacağım.',
            },
          ],
        },
      }) + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildAutoContinuePrompt(
        tempProjectPath,
        'session-generic-plan',
      )
      expect(prompt).toContain('Automatic keep-alive continuation.')
      expect(prompt).toContain('Do not send another progress-only update.')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildAutoContinuePrompt resumes generic unresolved tool results', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'generic-auto-tool-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const transcriptPath = join(projectDir, 'session-generic-tool.jsonl')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'tool_use', name: 'Read' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call_read' }],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildAutoContinuePrompt(
        tempProjectPath,
        'session-generic-tool',
      )
      expect(prompt).toContain('Automatic keep-alive continuation.')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildAutoContinuePrompt ignores trailing meta skill payloads after a tool result', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'generic-auto-skill-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const transcriptPath = join(projectDir, 'session-generic-skill.jsonl')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: 'assistant',
          isSidechain: false,
          message: {
            stop_reason: 'end_turn',
            content: [{ type: 'tool_use', name: 'Skill' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          isSidechain: false,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'call_skill' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          isMeta: true,
          isSidechain: false,
          message: {
            content: [
              {
                type: 'text',
                text: 'Base directory for this skill: /tmp/skill',
              },
            ],
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildAutoContinuePrompt(
        tempProjectPath,
        'session-generic-skill',
      )
      expect(prompt).toContain('Automatic keep-alive continuation.')
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })

  test('maybeBuildAutoContinuePrompt skips blocker-style assistant questions', async () => {
    const tempProjectPath = await mkdtemp(join(tmpdir(), 'generic-auto-skip-'))
    const projectDir = getPersistedProjectDir(tempProjectPath)
    const transcriptPath = join(projectDir, 'session-generic-skip.jsonl')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        isSidechain: false,
        message: {
          content: [
            {
              type: 'text',
              text:
                'Plan hazır. Bunu docs altında mı yoksa root altında mı kaydetmemi istersin?',
            },
          ],
        },
      }) + '\n',
      'utf8',
    )

    try {
      const prompt = await maybeBuildAutoContinuePrompt(
        tempProjectPath,
        'session-generic-skip',
      )
      expect(prompt).toBeNull()
    } finally {
      await rm(projectDir, { recursive: true, force: true })
      await rm(tempProjectPath, { recursive: true, force: true })
    }
  })
})
