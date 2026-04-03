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

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

function loadAuth(): CodexAuthData {
  const now = Date.now()
  // Re-read from disk at most every 30s (another process may have refreshed)
  if (cachedAuth && now - lastAuthReadMs < 30_000) return cachedAuth
  const authPath = join(getCodexHome(), 'auth.json')
  const raw = readFileSync(authPath, 'utf-8')
  cachedAuth = JSON.parse(raw) as CodexAuthData
  lastAuthReadMs = now
  return cachedAuth
}

function saveAuth(auth: CodexAuthData): void {
  const authPath = join(getCodexHome(), 'auth.json')
  writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
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
  return `${prefix}_${Math.random().toString(36).slice(2, 15)}`
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
  private toolCallBlocks: Map<number, { callId: string; name: string }> = new Map()
  private totalOutputTokens = 0
  private inputTokens = 0
  private finishReason = 'end_turn'
  private done = false

  // claude.ts checks for this property to distinguish stream from error objects
  readonly controller = {} as AbortController

  constructor(
    private response: Response,
    model: string,
  ) {
    this.reader = response.body!.getReader()
    this.model = model
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
        usage: { input_tokens: 0, output_tokens: 0 },
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
          try {
            const data = JSON.parse(dataStr)
            yield* this.processEvent(currentEvent, data)
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    // Close any open text block
    if (this.currentTextBlockOpen) {
      yield { type: 'content_block_stop', index: this.anthropicBlockIndex }
      this.anthropicBlockIndex++
      this.currentTextBlockOpen = false
    }

    // Emit message_delta + message_stop
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: this.finishReason,
        stop_sequence: null,
      },
      usage: { output_tokens: this.totalOutputTokens },
    }

    yield { type: 'message_stop' }
  }

  private *processEvent(event: string, data: Record<string, unknown>): Generator<AnyStreamEvent> {
    switch (event) {
      case 'response.created':
      case 'response.in_progress':
        if (data.id) this.responseId = data.id as string
        break

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
        const status = data.status as string
        if (status === 'completed') {
          // Check if there were tool calls → stop_reason = tool_use
          const output = data.output as Array<Record<string, unknown>> | undefined
          if (output?.some(o => o.type === 'function_call')) {
            this.finishReason = 'tool_use'
          }
        }
        // Extract usage
        const usage = data.usage as Record<string, number> | undefined
        if (usage) {
          this.inputTokens = usage.input_tokens || 0
          this.totalOutputTokens = usage.output_tokens || 0
        }
        this.done = true
        break
      }

      case 'response.failed': {
        const error = data.error as Record<string, string> | undefined
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
// Main adapter class — duck-types as Anthropic SDK client
// ---------------------------------------------------------------------------

export class OpenAIAdapter {
  private timeout: number

  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
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
    this.timeout = config.timeout || 600_000

    const self = this
    this.beta = {
      messages: {
        create(params: Record<string, unknown>, options?: Record<string, unknown>) {
          return {
            async withResponse() {
              const response = await self.makeRequest(params, options)
              const model = process.env.CODEX_MODEL || (params.model as string) || DEFAULT_MODEL
              const stream = new ResponsesStreamToAnthropicStream(response, model)
              return {
                data: stream,
                request_id: response.headers.get('x-request-id') || genId('req'),
                response,
              }
            },
          }
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

    const body: Record<string, unknown> = {
      model,
      input,
      stream: true,
      store: false,
    }

    if (instructions) {
      body.instructions = instructions
    }

    // Reasoning/effort
    body.reasoning = {
      effort,
      summary: 'concise',
    }

    // Tools
    if (tools && tools.length > 0) {
      body.tools = tools
    }

    // Note: max_output_tokens and temperature are not supported by the
    // chatgpt.com/backend-api/codex endpoint — omitted intentionally

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
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
      signal.addEventListener('abort', () => controller.abort())
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

        // If 401 and we have refresh token, try one more time after force-refresh
        if (status === 401 && auth.tokens?.refresh_token) {
          clearTimeout(timeoutId)
          cachedAuth = null  // force re-read
          lastAuthReadMs = 0
          const freshAuth = await ensureFreshToken()
          if (freshAuth.tokens) {
            headers['Authorization'] = `Bearer ${freshAuth.tokens.access_token}`
            const retryResponse = await fetch(`${baseURL}/responses`, {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            })
            if (retryResponse.ok) return retryResponse
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
