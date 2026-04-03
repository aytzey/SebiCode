/**
 * Codex Adapter for sebi-code
 *
 * Uses the local Codex OAuth tokens (~/.codex/auth.json) to call OpenAI's
 * Responses API at chatgpt.com/backend-api/codex. Translates between the
 * Anthropic Messages API interface (used by claude.ts) and the Responses API
 * wire format, including streaming events.
 *
 * Model: gpt-5.4 (default)
 * Effort: xhigh (default, maps from Claude's thinking config)
 *
 * Activation:
 *   CLAUDE_CODE_USE_CODEX=1
 *
 * Optional overrides:
 *   CODEX_MODEL             — override model (default: gpt-5.4)
 *   CODEX_EFFORT            — override effort (default: xhigh)
 *   CODEX_BASE_URL          — override API base (default: https://chatgpt.com/backend-api/codex)
 *   CODEX_HOME              — override config dir (default: ~/.codex)
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'

// ---------------------------------------------------------------------------
// Codex Auth — reads ~/.codex/auth.json, handles token refresh
// ---------------------------------------------------------------------------

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const DEFAULT_CODEX_BASE = 'https://chatgpt.com/backend-api/codex'
const DEFAULT_MODEL = 'gpt-5.4'
const DEFAULT_EFFORT = 'xhigh'
// Refresh if token expires within this many seconds
const REFRESH_MARGIN_S = 300

interface CodexAuthData {
  auth_mode: string
  OPENAI_API_KEY: string | null
  tokens?: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id: string
  }
  last_refresh?: string
}

let cachedAuth: CodexAuthData | null = null
let lastAuthReadMs = 0
let refreshPromise: Promise<CodexAuthData> | null = null

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function loadAuth(): CodexAuthData {
  const now = Date.now()
  // Re-read from disk at most every 30s (another process may have refreshed)
  if (cachedAuth && now - lastAuthReadMs < 30_000) return cachedAuth
  const authPath = join(getCodexHome(), 'auth.json')
  let raw: string
  try {
    raw = readFileSync(authPath, 'utf-8')
  } catch {
    throw new Error(
      `No Codex auth found at ${authPath}. Run \`codex\` first to authenticate, or set CODEX_HOME to the correct directory.`,
    )
  }
  try {
    cachedAuth = JSON.parse(raw) as CodexAuthData
  } catch {
    throw new Error(`Codex auth file at ${authPath} contains invalid JSON. Delete it and re-authenticate with \`codex\`.`)
  }
  lastAuthReadMs = now
  return cachedAuth
}

function saveAuth(auth: CodexAuthData): void {
  const authPath = join(getCodexHome(), 'auth.json')
  // Atomic write: write to temp file then rename to avoid corruption from concurrent processes
  const tmpPath = `${authPath}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
  renameSync(tmpPath, authPath)
  cachedAuth = auth
  lastAuthReadMs = Date.now()
}

function decodeJwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return null
    const json = Buffer.from(payload, 'base64url').toString('utf-8')
    const data = JSON.parse(json)
    return typeof data.exp === 'number' ? data.exp : null
  } catch {
    return null
  }
}

async function ensureFreshToken(): Promise<CodexAuthData> {
  const auth = loadAuth()

  // API key mode — no refresh needed
  if (auth.auth_mode === 'api_key' || !auth.tokens) return auth

  // Check access_token expiry
  const exp = decodeJwtExp(auth.tokens.access_token)
  const now = Math.floor(Date.now() / 1000)
  if (exp && exp - now > REFRESH_MARGIN_S) return auth

  // Deduplicate concurrent refresh attempts (rotating refresh tokens
  // can be invalidated if used twice)
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefresh(auth).finally(() => { refreshPromise = null })
  return refreshPromise
}

async function doRefresh(auth: CodexAuthData): Promise<CodexAuthData> {
  // Token expired or about to — refresh
  const resp = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: auth.tokens.refresh_token,
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Codex token refresh failed (${resp.status}): ${body}`)
  }

  const data = await resp.json() as Record<string, string>

  // Update only fields that came back
  if (data.access_token) auth.tokens.access_token = data.access_token
  if (data.id_token) auth.tokens.id_token = data.id_token
  if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token
  auth.last_refresh = new Date().toISOString()

  saveAuth(auth)
  return auth
}

// ---------------------------------------------------------------------------
// Anthropic message/tool types (minimal shapes)
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: unknown
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: 'text'; text: string } | { type: string; [k: string]: unknown }>
  is_error?: boolean
}

interface AnthropicImageBlock {
  type: 'image'
  source: { type: string; media_type: string; data: string }
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | { type: 'thinking'; thinking: string }
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: unknown
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  type?: string
  cache_control?: unknown
}

// ---------------------------------------------------------------------------
// Responses API input/output types
// ---------------------------------------------------------------------------

type ResponsesInputItem =
  | { role: 'user' | 'assistant' | 'system'; content: string | ResponsesContentPart[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string; id?: string }
  | { type: 'function_call_output'; call_id: string; output: string }

interface ResponsesContentPart {
  type: 'input_text' | 'input_image'
  text?: string
  image_url?: string
}

interface ResponsesTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

// ---------------------------------------------------------------------------
// Message translation: Anthropic → Responses API
// ---------------------------------------------------------------------------

function translateSystem(system: AnthropicSystemBlock[] | string | undefined): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system.map(b => b.text).join('\n\n')
}

function translateMessages(messages: AnthropicMessage[]): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
        continue
      }

      const textParts: string[] = []
      const contentParts: ResponsesContentPart[] = []
      let hasImages = false

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
          contentParts.push({ type: 'input_text', text: block.text })
        } else if (block.type === 'tool_result') {
          const tr = block as AnthropicToolResultBlock
          const output = typeof tr.content === 'string'
            ? tr.content
            : tr.content.map(c => c.type === 'text' ? c.text : '[binary]').join('\n')
          result.push({
            type: 'function_call_output',
            call_id: tr.tool_use_id,
            output: (tr.is_error ? '[ERROR] ' : '') + output,
          })
        } else if (block.type === 'image') {
          const img = block as AnthropicImageBlock
          hasImages = true
          contentParts.push({
            type: 'input_image',
            image_url: `data:${img.source.media_type};base64,${img.source.data}`,
          })
        }
      }

      // Emit user text/image content if any
      if (textParts.length > 0 || hasImages) {
        if (hasImages) {
          result.push({ role: 'user', content: contentParts })
        } else {
          result.push({ role: 'user', content: textParts.join('\n') })
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
        continue
      }

      const textParts: string[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_use') {
          // Flush accumulated text before tool calls
          if (textParts.length > 0) {
            result.push({ role: 'assistant', content: textParts.join('\n') })
            textParts.length = 0
          }
          const tu = block as AnthropicToolUseBlock
          result.push({
            type: 'function_call',
            call_id: tu.id,
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          })
        }
        // Skip 'thinking' blocks — Responses API uses reasoning internally
      }

      if (textParts.length > 0) {
        result.push({ role: 'assistant', content: textParts.join('\n') })
      }
    }
  }

  return result
}

function translateTools(tools: AnthropicTool[] | undefined): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter(t => !t.type || t.type === 'custom')
    .map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
      strict: false,
    }))
}

// ---------------------------------------------------------------------------
// Effort mapping: Claude thinking config → Codex reasoning effort
// ---------------------------------------------------------------------------

// Claude effort → Codex reasoning_effort mapping
const EFFORT_MAP: Record<string, string> = {
  'max': 'xhigh',
  'high': 'xhigh',
  'medium': 'high',
  'low': 'medium',
}

function resolveEffort(params: Record<string, unknown>): string {
  // Explicit env override
  const envEffort = process.env.CODEX_EFFORT
  if (envEffort) return envEffort

  // Check Claude's output_config.effort parameter (set by /effort command)
  const outputConfig = params.output_config as Record<string, unknown> | undefined
  if (outputConfig?.effort) {
    const claudeEffort = String(outputConfig.effort)
    return EFFORT_MAP[claudeEffort] || DEFAULT_EFFORT
  }

  // Map from Claude's thinking config
  const thinking = params.thinking as { type: string; budget_tokens?: number } | undefined
  if (!thinking || thinking.type === 'disabled') return DEFAULT_EFFORT

  // Budget-based mapping
  if (thinking.budget_tokens) {
    if (thinking.budget_tokens >= 32000) return 'xhigh'
    if (thinking.budget_tokens >= 16000) return 'high'
    if (thinking.budget_tokens >= 4000) return 'medium'
    return 'low'
  }

  // Adaptive thinking → xhigh
  return DEFAULT_EFFORT
}

// ---------------------------------------------------------------------------
// Generate unique IDs
// ---------------------------------------------------------------------------

function genId(prefix = 'msg'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 15)}`
}

// ---------------------------------------------------------------------------
// Responses API SSE stream → Anthropic stream event translator
// ---------------------------------------------------------------------------

type AnyStreamEvent =
  | { type: 'message_start'; message: unknown }
  | { type: 'content_block_start'; index: number; content_block: unknown }
  | { type: 'content_block_delta'; index: number; delta: unknown }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: unknown; usage: unknown }
  | { type: 'message_stop' }

class ResponsesStreamToAnthropicStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private decoder = new TextDecoder()
  private buffer = ''
  private model: string
  private responseId = ''
  private anthropicBlockIndex = 0
  private currentTextBlockOpen = false
  // toolCallBlocks tracks in-flight function_call items by output_index for correlation
  private toolCallBlocks: Map<number, { callId: string; name: string }> = new Map()
  private totalOutputTokens = 0
  private inputTokens = 0
  private cachedInputTokens = 0
  private finishReason = 'end_turn'
  private done = false

  // claude.ts checks for this property to distinguish stream from error objects
  readonly controller: AbortController

  constructor(
    response: Response,
    model: string,
  ) {
    if (!response.body) {
      throw new Error('Codex API response has no body (streaming not supported?)')
    }
    this.reader = response.body.getReader()
    this.model = model
    // Wire up a real AbortController so callers can cancel the stream
    this.controller = new AbortController()
    this.controller.signal.addEventListener('abort', () => {
      this.reader.cancel().catch(() => {})
    })
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AnyStreamEvent> {
    // Emit message_start
    yield {
      type: 'message_start',
      message: {
        id: this.responseId || genId('msg'),
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    // Read SSE stream
    while (!this.done) {
      const { done, value } = await this.reader.read()
      if (done) break

      this.buffer += this.decoder.decode(value, { stream: true })
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop()!

      let currentEvent = ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) {
          currentEvent = ''
          continue
        }
        if (trimmed.startsWith('event: ')) {
          currentEvent = trimmed.slice(7)
          continue
        }
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.slice(6)
          if (dataStr === '[DONE]') {
            this.done = true
            break
          }
          let data: Record<string, unknown>
          try {
            data = JSON.parse(dataStr)
          } catch {
            continue // skip malformed JSON
          }
          // processEvent errors (e.g. response.failed) must propagate
          yield* this.processEvent(currentEvent, data)
        }
      }
    }

    // Close any open text block
    if (this.currentTextBlockOpen) {
      yield { type: 'content_block_stop', index: this.anthropicBlockIndex }
      this.anthropicBlockIndex++
      this.currentTextBlockOpen = false
    }

    // Emit message_delta + message_stop (include cached token stats)
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: this.finishReason,
        stop_sequence: null,
      },
      usage: {
        input_tokens: this.inputTokens,
        output_tokens: this.totalOutputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: this.cachedInputTokens,
      },
    }

    yield { type: 'message_stop' }
  }

  private *processEvent(event: string, data: Record<string, unknown>): Generator<AnyStreamEvent> {
    switch (event) {
      case 'response.created':
      case 'response.in_progress': {
        // Some endpoints nest the response object under data.response
        const resp = (data.response as Record<string, unknown>) || data
        if (resp.id) this.responseId = resp.id as string
        break
      }

      case 'response.output_item.added': {
        const item = data.item as Record<string, unknown>
        if (!item) break

        if (item.type === 'message') {
          // Text message output starting — we'll open the block on first delta
        } else if (item.type === 'function_call') {
          // Close text block if open
          if (this.currentTextBlockOpen) {
            yield { type: 'content_block_stop', index: this.anthropicBlockIndex }
            this.anthropicBlockIndex++
            this.currentTextBlockOpen = false
          }
          // Start tool_use block
          const outputIndex = data.output_index as number
          const callId = (item.call_id as string) || genId('call')
          const name = (item.name as string) || ''
          this.toolCallBlocks.set(outputIndex, { callId, name })
          yield {
            type: 'content_block_start',
            index: this.anthropicBlockIndex,
            content_block: {
              type: 'tool_use',
              id: callId,
              name,
              input: {},
            },
          }
        }
        break
      }

      case 'response.content_part.added':
        // Text content part starting — open text block if not already open
        if (!this.currentTextBlockOpen) {
          this.currentTextBlockOpen = true
          yield {
            type: 'content_block_start',
            index: this.anthropicBlockIndex,
            content_block: { type: 'text', text: '' },
          }
        }
        break

      case 'response.output_text.delta': {
        const delta = data.delta as string
        if (!delta) break
        if (!this.currentTextBlockOpen) {
          this.currentTextBlockOpen = true
          yield {
            type: 'content_block_start',
            index: this.anthropicBlockIndex,
            content_block: { type: 'text', text: '' },
          }
        }
        yield {
          type: 'content_block_delta',
          index: this.anthropicBlockIndex,
          delta: { type: 'text_delta', text: delta },
        }
        break
      }

      case 'response.output_text.done':
        // Text done — close text block
        if (this.currentTextBlockOpen) {
          yield { type: 'content_block_stop', index: this.anthropicBlockIndex }
          this.anthropicBlockIndex++
          this.currentTextBlockOpen = false
        }
        break

      case 'response.function_call_arguments.delta': {
        const argsDelta = data.delta as string
        if (!argsDelta) break
        yield {
          type: 'content_block_delta',
          index: this.anthropicBlockIndex,
          delta: { type: 'input_json_delta', partial_json: argsDelta },
        }
        break
      }

      case 'response.function_call_arguments.done':
        // Function call complete — close block
        yield { type: 'content_block_stop', index: this.anthropicBlockIndex }
        this.anthropicBlockIndex++
        break

      case 'response.output_item.done':
        // Item done — already handled by text.done / arguments.done
        break

      case 'response.completed': {
        // Handle both flat format (data.status) and nested format (data.response.status)
        const resp = (data.response as Record<string, unknown>) || data
        const status = resp.status as string
        if (status === 'completed') {
          // Check if there were tool calls → stop_reason = tool_use
          const output = resp.output as Array<Record<string, unknown>> | undefined
          if (output?.some(o => o.type === 'function_call')) {
            this.finishReason = 'tool_use'
          }
        }
        // Extract usage — map cached tokens to Anthropic's cache_read_input_tokens
        const usage = (resp.usage as Record<string, unknown>) || (data.usage as Record<string, unknown>)
        if (usage) {
          this.inputTokens = (usage.input_tokens as number) || 0
          this.totalOutputTokens = (usage.output_tokens as number) || 0
          // OpenAI reports cached tokens in prompt_tokens_details.cached_tokens
          const details = usage.input_tokens_details as Record<string, number> | undefined
          if (details?.cached_tokens) {
            this.cachedInputTokens = details.cached_tokens
          }
        }
        this.done = true
        break
      }

      case 'response.incomplete': {
        // Response was truncated (e.g. max_output_tokens reached)
        // Treat like a normal completion — let the caller handle the truncated output
        const resp = (data.response as Record<string, unknown>) || data
        const usage = (resp.usage as Record<string, unknown>) || (data.usage as Record<string, unknown>)
        if (usage) {
          this.inputTokens = (usage.input_tokens as number) || 0
          this.totalOutputTokens = (usage.output_tokens as number) || 0
          const details = usage.input_tokens_details as Record<string, number> | undefined
          if (details?.cached_tokens) this.cachedInputTokens = details.cached_tokens
        }
        this.finishReason = 'max_tokens'
        this.done = true
        break
      }

      case 'response.failed': {
        const resp = (data.response as Record<string, unknown>) || data
        const error = (resp.error as Record<string, string>) || (data.error as Record<string, string>)
        const errMsg = error?.message || 'Unknown error from Responses API'
        throw new Error(`Codex API error: ${errMsg}`)
      }

      // Reasoning events — skip (internal thinking)
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        break

      default:
        // Unknown event — skip silently
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: consume a Responses stream into a complete Anthropic BetaMessage shape
// ---------------------------------------------------------------------------

async function consumeStreamToMessage(stream: ResponsesStreamToAnthropicStream, model: string): Promise<Record<string, unknown>> {
  const contentBlocks: unknown[] = []
  let stopReason = 'end_turn'
  let usage: Record<string, unknown> = { input_tokens: 0, output_tokens: 0 }
  let messageId = genId('msg')

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        const msg = event.message as Record<string, unknown>
        if (msg.id) messageId = msg.id as string
        break
      }
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown>
        if (block.type === 'text') {
          contentBlocks.push({ type: 'text', text: '' })
        } else if (block.type === 'tool_use') {
          contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: {} })
        }
        break
      }
      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown>
        const current = contentBlocks[event.index] as Record<string, unknown> | undefined
        if (!current) break
        if (delta.type === 'text_delta') {
          current.text = (current.text as string) + (delta.text as string)
        } else if (delta.type === 'input_json_delta') {
          current._rawJson = ((current._rawJson as string) || '') + (delta.partial_json as string)
        }
        break
      }
      case 'content_block_stop': {
        const current = contentBlocks[event.index] as Record<string, unknown> | undefined
        if (current?.type === 'tool_use' && current._rawJson) {
          try { current.input = JSON.parse(current._rawJson as string) } catch { /* keep empty input */ }
          delete current._rawJson
        }
        break
      }
      case 'message_delta': {
        const delta = event.delta as Record<string, unknown>
        if (delta.stop_reason) stopReason = delta.stop_reason as string
        if (event.usage) usage = event.usage as Record<string, unknown>
        break
      }
    }
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  }
}

// ---------------------------------------------------------------------------
// Main adapter class — duck-types as Anthropic SDK client
// ---------------------------------------------------------------------------

export class OpenAIAdapter {
  private timeout: number

  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<Record<string, unknown>> & {
        withResponse: () => Promise<{
          data: ResponsesStreamToAnthropicStream
          request_id: string
          response: Response
        }>
      }
    }
  }

  constructor(config: {
    timeout?: number
    [key: string]: unknown
  }) {
    this.timeout = config.timeout ?? 600_000

    const self = this
    this.beta = {
      messages: {
        create(params: Record<string, unknown>, options?: Record<string, unknown>) {
          const model = process.env.CODEX_MODEL || (params.model as string) || DEFAULT_MODEL

          // Lazy: don't fire the API request until someone actually awaits or calls .withResponse().
          // This prevents double-requests when callers chain .withResponse().
          let consumed = false

          // Base promise (for direct `await create()` callers like sideQuery)
          const messagePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
            // Defer execution to microtask so .withResponse() has a chance to pre-empt
            queueMicrotask(() => {
              if (consumed) return // .withResponse() was called first, skip
              consumed = true
              self.makeRequest(params, options)
                .then(async (response) => {
                  const stream = new ResponsesStreamToAnthropicStream(response, model)
                  return consumeStreamToMessage(stream, model)
                })
                .then(resolve, reject)
            })
          })

          // Attach .withResponse() for streaming callers (used by claude.ts queryModel)
          const thenable = messagePromise as Promise<Record<string, unknown>> & {
            withResponse: () => Promise<{
              data: ResponsesStreamToAnthropicStream
              request_id: string
              response: Response
            }>
          }
          thenable.withResponse = async () => {
            consumed = true // prevent the lazy base promise from firing
            const response = await self.makeRequest(params, options)
            const stream = new ResponsesStreamToAnthropicStream(response, model)
            return {
              data: stream,
              request_id: response.headers.get('x-request-id') || genId('req'),
              response,
            }
          }
          return thenable
        },
      },
    }
  }

  private async makeRequest(
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<Response> {
    // Get fresh auth token
    const auth = await ensureFreshToken()

    // Model priority: CODEX_MODEL env > params.model (from --model flag) > default
    const paramsModel = params.model as string | undefined
    const model = process.env.CODEX_MODEL || paramsModel || DEFAULT_MODEL
    const baseURL = (process.env.CODEX_BASE_URL || DEFAULT_CODEX_BASE).replace(/\/$/, '')
    const effort = resolveEffort(params)

    // Translate Anthropic params → Responses API
    const instructions = translateSystem(params.system as AnthropicSystemBlock[] | string | undefined)
    const input = translateMessages(params.messages as AnthropicMessage[])
    const tools = translateTools(params.tools as AnthropicTool[] | undefined)

    // Session ID for prompt cache routing — ensures all turns in the same
    // conversation hit the same cache server (90% discount on cached tokens)
    let cacheKey: string | undefined
    try {
      cacheKey = getSessionId()
    } catch {
      // bootstrap state may not be ready yet
    }

    // Build request body matching official Codex CLI format exactly
    const hasReasoning = effort !== 'none'
    const body: Record<string, unknown> = {
      model,
      instructions: instructions || '',
      input,
      stream: true,
      store: false,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      // Prompt cache: route by session ID (90% discount on cached tokens)
      ...(cacheKey && { prompt_cache_key: cacheKey }),
      // Include encrypted reasoning content for context continuity
      include: hasReasoning ? ['reasoning.encrypted_content'] : [],
    }

    // Reasoning/effort — match Codex format
    if (hasReasoning) {
      body.reasoning = { effort, summary: 'auto' }
    }

    // NOTE: max_output_tokens is NOT sent — the Codex chatgpt.com endpoint
    // rejects it with 400. The model uses its own default output limit.

    // Tools — keep in stable order for cache prefix matching
    if (tools && tools.length > 0) {
      body.tools = tools
    }

    // Build headers — match Codex CLI headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...(cacheKey && {
        'session_id': cacheKey,
        'x-client-request-id': cacheKey,
      }),
    }

    if (auth.auth_mode === 'api_key' && auth.OPENAI_API_KEY) {
      // API key mode
      headers['Authorization'] = `Bearer ${auth.OPENAI_API_KEY}`
    } else if (auth.tokens) {
      // ChatGPT OAuth mode
      headers['Authorization'] = `Bearer ${auth.tokens.access_token}`
      if (auth.tokens.account_id) {
        headers['ChatGPT-Account-ID'] = auth.tokens.account_id
      }
    } else {
      throw new Error(
        'No Codex auth found. Run `codex` first to authenticate, or set CODEX_API_KEY.',
      )
    }

    // Forward abort signal
    const signal = (options?.signal as AbortSignal) || undefined
    const controller = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${baseURL}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorBody = await response.text()
        const status = response.status
        const error = new Error(`Codex API error ${status}: ${errorBody}`) as Error & {
          status: number
          error?: { type: string; message: string }
        }
        error.status = status
        try {
          const parsed = JSON.parse(errorBody)
          error.error = {
            type: status === 429 ? 'rate_limit_error'
              : status === 401 ? 'authentication_error'
              : 'api_error',
            message: parsed?.error?.message || parsed?.detail || errorBody,
          }
        } catch {
          error.error = { type: 'api_error', message: errorBody }
        }

        // Retry strategy aligned with Codex CLI (codex-rs):
        //   - 5xx: retry with exponential backoff (server errors are transient)
        //   - 429: retry once after retry-after delay
        //   - 404: NOT retried (Codex doesn't retry 404 either)
        // Max 4 attempts, base delay 200ms, exponential backoff with jitter
        const isRetryable = status >= 500 || status === 429
        if (isRetryable) {
          const MAX_RETRIES = 3 // + original attempt = 4 total (matches Codex default)
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            // Exponential backoff with jitter: 200ms * 2^attempt * jitter(0.9-1.1)
            const baseMs = status === 429
              ? parseInt(response.headers.get('retry-after') || '2', 10) * 1000
              : 200
            const expMs = baseMs * Math.pow(2, attempt)
            const jitter = 0.9 + Math.random() * 0.2
            const waitMs = Math.min(expMs * jitter, 30_000)
            await new Promise(resolve => setTimeout(resolve, waitMs))
            const retryController = new AbortController()
            const retryTimeout = setTimeout(() => retryController.abort(), this.timeout)
            try {
              const retryResponse = await fetch(`${baseURL}/responses`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: retryController.signal,
              })
              clearTimeout(retryTimeout)
              if (retryResponse.ok) return retryResponse
              // If still a server error, continue retrying
              if (retryResponse.status < 500 && retryResponse.status !== 429) break
            } catch {
              clearTimeout(retryTimeout)
              // Network/transport error — continue retrying (matches Codex retry_transport)
            }
          }
        }

        // If 401 and we have refresh token, try one more time after force-refresh
        if (status === 401 && auth.tokens?.refresh_token) {
          cachedAuth = null  // force re-read
          lastAuthReadMs = 0
          const freshAuth = await ensureFreshToken()
          if (freshAuth.tokens) {
            headers['Authorization'] = `Bearer ${freshAuth.tokens.access_token}`
            // Use a fresh AbortController — the original may already be aborted
            const retryController = new AbortController()
            const retryTimeout = setTimeout(() => retryController.abort(), this.timeout)
            try {
              const retryResponse = await fetch(`${baseURL}/responses`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: retryController.signal,
              })
              clearTimeout(retryTimeout)
              if (retryResponse.ok) return retryResponse
            } catch {
              clearTimeout(retryTimeout)
              // fall through to throw original error
            }
          }
        }

        throw error
      }

      return response
    } catch (err) {
      clearTimeout(timeoutId)
      throw err
    }
  }
}
