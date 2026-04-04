# AGENTS.md — sebi-code (mirror of CLAUDE.md for Codex/Gemini/other agents)

Modified Claude Code 2.1.88 with dual-provider support (Anthropic + OpenAI/Codex) and `/sebiralph` dual-model orchestration skill.

## What This Is

A source-built Claude Code that can run on **both** Anthropic Claude AND OpenAI Codex models simultaneously. Built from the official CLI's source map with three layers of modifications:

1. **Cache fixes** (from cc-cache-fix) — db8 attachment filter, fingerprint meta skip, 1h cache TTL
2. **Codex provider** — Full OpenAI Responses API adapter using Codex OAuth tokens
3. **`/sebiralph` skill** — Dual-model orchestration: Claude plans + reviews, Codex implements

## Quick Start

```bash
# Build (requires Node 20+, Bun 1.1+)
export PATH="$HOME/.bun/bin:$PATH"
node scripts/build-cli.mjs --no-minify

# Run as Claude (Anthropic OAuth from ~/.claude/.credentials.json)
node dist/cli.js

# Run as Codex (OpenAI OAuth from ~/.codex/auth.json)
CLAUDE_CODE_USE_CODEX=1 node dist/cli.js

# Wrappers (in ~/.local/bin/)
sebi              # Codex mode (gpt-5.4, xhigh effort)
sebi-claude       # Claude mode (Opus 4.6)
sebi-auto         # Auto-detect: Codex auth exists → Codex, else Claude
```

## Architecture

### Provider System

```
getAPIProvider() → 'codex' | 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
                     ↓              ↓
              OpenAIAdapter    Anthropic SDK
              (Responses API)  (Messages API)
```

**Provider selection**: `CLAUDE_CODE_USE_CODEX=1` env var, or per-agent `providerOverride` field.

**Per-agent provider routing** (the key innovation): Parallel subagents can use different providers via `providerOverride: 'anthropic' | 'openai'` passed through the chain:

```
AgentTool.tsx (provider param)
  → runAgent.ts (providerOverride in params)
    → agentOptions.providerOverride
      → queryModel options.providerOverride
        → getAnthropicClient({ providerOverride })
          → 'openai' → OpenAIAdapter
          → 'anthropic' → Anthropic SDK (with OAuth + beta headers)
```

### OpenAI Adapter (`source/src/services/api/openai-adapter.ts`)

Translates Anthropic Messages API ↔ OpenAI Responses API:

| Anthropic | OpenAI/Codex |
|-----------|-------------|
| `system` (array of text blocks) | `instructions` (string) |
| `messages` (user/assistant array) | `input` (ResponseItem array) |
| `tool_use` content blocks | `function_call` items |
| `tool_result` in user messages | `function_call_output` items |
| `cache_control` markers | `prompt_cache_key` (session ID) |
| `thinking` config | `reasoning: { effort, summary }` |
| Stream: `content_block_delta` | Stream: `response.output_text.delta` |
| Stream: `message_delta` | Stream: `response.completed` |

**Auth**: Reads `~/.codex/auth.json` (Codex CLI's OAuth tokens). Auto-refreshes via `auth.openai.com/oauth/token` when expired. Client ID: `app_EMoamEEZ73f0CkXaXp7hrann`.

**API endpoint**: `https://chatgpt.com/backend-api/codex/responses` (ChatGPT OAuth mode).

**Request format matches official Codex CLI**:
- `tool_choice: "auto"`, `parallel_tool_calls: true`
- `include: ["reasoning.encrypted_content"]` when reasoning enabled
- `reasoning: { effort: "xhigh", summary: "auto" }`
- `prompt_cache_key: sessionId` for cache routing (90% discount)
- `store: false`
- Headers: `Accept: text/event-stream`, `session_id`, `x-client-request-id`, `ChatGPT-Account-ID`

### Cross-Provider Subagent Support

When a Codex session spawns a Claude subagent (or vice versa):

1. **Model mapping** (`runAgent.ts`): `gpt-5.4` → `claude-sonnet-4-6` (for anthropic), `claude-*` → `gpt-5.4` (for openai)
2. **Auth injection** (`client.ts`): `forceAnthropic` flag skips Codex/Bedrock/Vertex checks, uses OAuth from `~/.claude/.credentials.json`
3. **Beta headers** (`claude.ts`): `oauth-2025-04-20` + `claude-code-20250219` injected when `providerOverride='anthropic'`
4. **SDK patch** (`build-cli.mjs`): Post-build patches guard `event.usage` in Anthropic SDK's MessageStream (prevents crash when usage is temporarily undefined)

### Model Configuration

All 11 model configs have a `codex` field (`source/src/utils/model/configs.ts`):

| Claude Model | Codex Mapping |
|---|---|
| All (Opus, Sonnet, Haiku) | `gpt-5.4` |

**Default model in Codex mode**: `gpt-5.4` (override with `CODEX_MODEL` env var).
**Small/fast model**: `gpt-5.4-mini`.
**Context window**: 272,000 tokens.

Available Codex models (from `~/.codex/models_cache.json`):
`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`

### Capability Gates Unblocked for Codex

| Feature | How |
|---|---|
| Auto mode | `betas.ts`: codex added to provider allowlist |
| Effort parameter | `effort.ts`: `modelSupportsEffort` returns true for codex |
| Max effort | `effort.ts`: `modelSupportsMaxEffort` returns true for codex |
| Fast mode | `fastMode.ts`: codex allowed |
| Prompt caching | Disabled (OpenAI uses automatic caching) |
| Thinking blocks | Disabled (gpt-5.4 uses `reasoning_effort` internally) |
| Off-switch | `claude.ts`: tengu-off-switch bypassed for codex |

## `/sebiralph` — Dual-Model Orchestration

### Usage

```bash
# In Claude mode (orchestrator = Claude Opus)
sebi-claude
> /sebiralph Add authentication with JWT tokens

# In Codex mode (orchestrator = Codex gpt-5.4)
sebi
> /sebiralph Add authentication with JWT tokens
```

### Architecture

```
/sebiralph "task description"
  │
  ├─ Phase 0: Config + workflow defaults
  │   TDD: ON by default
  │
  ├─ Phase 1: Planning (sequential)
  │   Planner (Claude Opus) → JSON plan
  │   Evaluator (Codex gpt-5.4) → criteria-based review
  │   Loop max 3x until approved
  │
  ├─ Phase 2: PRD Approval
  │   Plan → markdown table → user approves
  │
  ├─ Phase 3: Swarm Implementation (parallel)
  │   Wave 0: contracts/shared (single agent)
  │   Wave 1+: parallel workers in git worktrees
  │   Workers follow red-green-refactor when TDD is on
  │   Workers: Codex (provider: openai)
  │   Frontend: Claude Sonnet (provider: anthropic)
  │   Deterministic gates: path ownership, build, lint, test
  │
  └─ Phase 4: Review, Merge, Deploy & Verify
      Claude Opus reviews each diff
      Fix loop → re-gate → re-review
      Merge to integration branch
      Deploy integrated branch
      Runtime verification on deployed surface
      If gaps remain: fix → re-gate → re-review → re-deploy until closed
```

### Default Roles

| Role | Provider | Model |
|------|----------|-------|
| Planner | anthropic | claude-opus-4-6 |
| Evaluator | openai | gpt-5.4 |
| Worker | openai | gpt-5.4 |
| Frontend | anthropic | claude-sonnet-4-6 |
| Reviewer | anthropic | claude-opus-4-6 |

### Key Types (`source/src/skills/sebiralph/types.ts`)

```typescript
type ModelRef = { provider: 'anthropic' | 'openai'; model: string }
type RalphRole = 'planner' | 'evaluator' | 'worker' | 'frontend' | 'reviewer'
type RalphConfig = Record<RalphRole, ModelRef>
type RalphWorkflowDefaults = {
  tdd: boolean
  deployVerification: boolean
  maxPlanIterations: number
  maxGateFixAttempts: number
  maxReviewFixCycles: number
  maxDeployFixCycles: number
}
type PRDTask = {
  id: string; title: string; description: string;
  role: 'worker' | 'frontend'; modelRef: ModelRef;
  ownedPaths: string[]; dependsOn: string[];
  acceptanceChecks: string[]; wave: number;
  status: 'pending' | 'in_progress' | 'review' | 'fix' | 'approved' | 'merged';
}
```

### Modules (`source/src/skills/sebiralph/`)

| File | Purpose |
|------|---------|
| `types.ts` | ModelRef, RalphConfig, workflow defaults, PRDTask, RalphPlan |
| `config.ts` | Default config, workflow defaults summary, model picker |
| `orchestrator.ts` | Main orchestration prompt (8-phase workflow with TDD default and deploy-verify loop) |
| `planner.ts` | Planner/evaluator prompts, hard gates, revision loop |
| `prd.ts` | PRD JSON schema, markdown renderer, plan validator |
| `swarm.ts` | Worker prompt builder, wave spec generator |
| `reviewer.ts` | Review prompt, verdict parser, fix instructions |
| `gates.ts` | Deterministic gates: path ownership, build, lint, test |
| `integration.ts` | Git integration branch + worktree management |
| `index.ts` | Bundled skill registration |

## Modified Files (from base Claude Code 2.1.88)

### Core Provider Chain (5 files)
- `services/api/client.ts` — `providerOverride` param, `forceAnthropic` path, OAuth injection
- `services/api/claude.ts` — `Options.providerOverride`, OAuth beta header injection, prompt caching disabled for codex, off-switch bypass
- `tools/AgentTool/AgentTool.tsx` — `provider` field in input schema
- `tools/AgentTool/runAgent.ts` — `providerOverride` param, cross-provider model mapping
- `tools/AgentTool/loadAgentsDir.ts` — `provider` field in BaseAgentDefinition
- `Tool.ts` — `providerOverride` in ToolUseContext options
- `query.ts` — pipe providerOverride to callModel

### Codex Adapter (1 file)
- `services/api/openai-adapter.ts` — Full Responses API adapter (NEW)

### Model System (4 files)
- `utils/model/providers.ts` — `'codex'` provider type
- `utils/model/configs.ts` — `codex` field on all 11 model configs
- `utils/model/model.ts` — Codex default model, display names, parseUserSpecifiedModel
- `utils/thinking.ts` — thinking disabled for codex

### Capability Gates (5 files)
- `utils/betas.ts` — auto mode unblocked for codex
- `utils/effort.ts` — effort + max effort enabled
- `utils/fastMode.ts` — fast mode allowed
- `utils/context.ts` — 272k context window
- `utils/auth.ts` — codex added to 3P provider list

### Usage Null Guards (17 files)
Cross-provider subagents can have temporarily undefined usage objects. These files were patched with `?.` and `?? 0` guards:
- `cost-tracker.ts`, `services/api/logging.ts`, `services/tokenEstimation.ts`
- `services/vcr.ts`, `services/compact/compact.ts`, `services/autoDream/autoDream.ts`
- `services/extractMemories/extractMemories.ts`, `services/PromptSuggestion/promptSuggestion.ts`
- `tasks/LocalAgentTask/LocalAgentTask.tsx`, `tools/AgentTool/UI.tsx`
- `utils/tokens.ts`, `utils/forkedAgent.ts`, `utils/analyzeContext.ts`
- `utils/context.ts`, `utils/modelCost.ts`, `utils/sideQuery.ts`
- `utils/advisor.ts`, `utils/permissions/yoloClassifier.ts`

### Cache Fixes (3 files, from source level)
- `utils/sessionStorage.ts` — persist deferred_tools_delta + mcp_instructions_delta
- `utils/fingerprint.ts` — skip isMeta messages for stable fingerprint
- `services/api/claude.ts` — force 1h cache TTL (`should1hCacheTTL` returns true)

### Build System (1 file)
- `scripts/build-cli.mjs` — Post-build SDK patch (event.usage null guards in MessageStream)

### Skill Registration (2 files)
- `skills/bundled/index.ts` — registerSebiRalphSkill() call
- `skills/bundledSkills.ts` — `effort` field added to BundledSkillDefinition

## Build

```bash
# Prerequisites
node --version  # >= 20
bun --version   # >= 1.1

# First build (extracts source map, installs ~80 npm packages)
node scripts/build-cli.mjs --no-minify

# Subsequent builds (faster, uses cached workspace)
node scripts/build-cli.mjs --no-minify

# Force clean rebuild
rm -f .cache/workspace/.prepared.json
node scripts/build-cli.mjs --no-minify
```

Output: `dist/cli.js` (wrapper) + `dist/cli.bundle/` (bundled code).

Post-build step patches the Anthropic SDK's MessageStream to guard `event.usage` access (prevents crash on cross-provider subagents).

## Environment Variables

### Codex Mode
| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_USE_CODEX=1` | Activate Codex provider |
| `CODEX_MODEL` | Override model (default: `gpt-5.4`) |
| `CODEX_EFFORT` | Override effort (default: `xhigh`) |
| `CODEX_BASE_URL` | Override API base (default: `chatgpt.com/backend-api/codex`) |
| `CODEX_HOME` | Override config dir (default: `~/.codex`) |

### Timeouts (important for Codex xhigh)
| Variable | Purpose |
|----------|---------|
| `CLAUDE_STREAM_IDLE_TIMEOUT_MS` | Stream idle timeout (default: 90000, set to 300000 for Codex) |
| `API_TIMEOUT_MS` | API request timeout (default: 600000, set to 900000 for Codex) |

### Claude Mode
Standard Claude Code env vars apply. OAuth tokens from `~/.claude/.credentials.json`.

## Git Branches

| Branch | Purpose |
|--------|---------|
| `master` | Base: source build + cache fixes |
| `codex-auto` | Codex adapter, model selection, caching, capability gates |
| `sebi-ralph` | Everything in codex-auto + /sebiralph skill + cross-provider fixes (HEAD) |

## Known Limitations

1. **Codex `/sebiralph` speed**: chatgpt.com endpoint is slower than api.openai.com. Orchestrator takes 2-3 min for first response with xhigh effort. Workaround: run in Claude mode (`sebi-claude`).

2. **Cross-provider subagent output**: Agent spawns work and don't crash, but some subagents return empty output when the parent is Codex. This is a timing issue with how the parent processes the subagent's response.

3. **SDK version**: Anthropic SDK is extracted from source map (v2.1.88 era). Newer SDK versions may fix the MessageStream event.usage issue natively.

## Development Tips

- Always `rm -f .cache/workspace/.prepared.json` before rebuilding after source changes to overlay files
- The `.cache/workspace/` directory contains extracted source from `source/cli.js.map` — don't edit these directly (they get overwritten)
- Edit files in `source/src/` — these are overlaid on top of extracted sources
- Post-build patches in `build-cli.mjs:finalizeBuild()` can modify the bundle after Bun builds it
- Test both modes after changes: `node dist/cli.js -p "ok"` AND `CLAUDE_CODE_USE_CODEX=1 node dist/cli.js -p "ok"`
