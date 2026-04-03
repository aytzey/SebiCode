/**
 * OpenAI/Codex Adapter for Claude Code
 *
 * Translates between the Anthropic Messages API interface (used internally)
 * and OpenAI's Chat Completions API. This allows Claude Code's entire tool
 * pipeline, streaming UI, and agentic loop to work unchanged with OpenAI models.
 *
 * Environment variables:
 *   OPENAI_API_KEY          — required
 *   OPENAI_BASE_URL         — optional, defaults to https://api.openai.com/v1
 *   OPENAI_MODEL            — optional, defaults to o3
 *   OPENAI_ORGANIZATION     — optional org header
 */

// ---------------------------------------------------------------------------
// Types — we define minimal shapes so this file has no import dependencies on
// the Anthropic SDK at the type level. The runtime only needs to produce
// objects whose shapes match what claude.ts consumes via iteration.
// ---------------------------------------------------------------------------

interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: string; ttl?: string }
}

interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
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
  content: string | Array<{ type: 'text'; text: string } | { type: 'image'; source: unknown }>
  is_error?: boolean
}

interface AnthropicImageBlock {
  type: 'image'
  source: { type: string; media_type: string; data: string }
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
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

// OpenAI types
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

interface OpenAIStreamChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// Anthropic stream event types (minimal shapes for what claude.ts consumes)
interface BetaRawMessageStartEvent {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: never[]
    model: string
    stop_reason: null
    stop_sequence: null
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  }
}

interface BetaRawContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block: { type: 'text'; text: '' } | { type: 'tool_use'; id: string; name: string; input: Record<string, never> }
}

interface BetaRawContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string }
}

interface BetaRawContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

interface BetaRawMessageDeltaEvent {
  type: 'message_delta'
  delta: { stop_reason: string; stop_sequence: null }
  usage: { output_tokens: number }
}

interface BetaRawMessageStopEvent {
  type: 'message_stop'
}

type BetaRawMessageStreamEvent =
  | BetaRawMessageStartEvent
  | BetaRawContentBlockStartEvent
  | BetaRawContentBlockDeltaEvent
  | BetaRawContentBlockStopEvent
  | BetaRawMessageDeltaEvent
  | BetaRawMessageStopEvent

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return 'chatcmpl-' + Math.random().toString(36).slice(2, 15)
}

function generateToolCallId(): string {
  return 'call_' + Math.random().toString(36).slice(2, 15)
}

/**
 * Convert Anthropic system blocks → single OpenAI system message
 */
function translateSystem(system: AnthropicSystemBlock[] | string | undefined): OpenAIMessage[] {
  if (!system) return []
  if (typeof system === 'string') {
    return [{ role: 'system', content: system }]
  }
  const text = system.map(b => b.text).join('\n\n')
  return text ? [{ role: 'system', content: text }] : []
}

/**
 * Convert Anthropic messages → OpenAI messages
 */
function translateMessages(messages: AnthropicMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content })
        continue
      }

      // User message with content blocks — may contain tool_result blocks
      const textParts: string[] = []
      const imageParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []
      const toolResults: AnthropicToolResultBlock[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'tool_result') {
          toolResults.push(block as AnthropicToolResultBlock)
        } else if (block.type === 'image') {
          const imgBlock = block as AnthropicImageBlock
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${imgBlock.source.media_type};base64,${imgBlock.source.data}` },
          })
        }
      }

      // Emit tool result messages first (OpenAI format: role=tool)
      for (const tr of toolResults) {
        const content = typeof tr.content === 'string'
          ? tr.content
          : tr.content.map(c => c.type === 'text' ? c.text : '[image]').join('\n')
        result.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: (tr.is_error ? '[ERROR] ' : '') + content,
        })
      }

      // Emit user text/image if any remain
      if (textParts.length > 0 || imageParts.length > 0) {
        if (imageParts.length > 0) {
          const content = [
            ...textParts.map(t => ({ type: 'text' as const, text: t })),
            ...imageParts,
          ]
          result.push({ role: 'user', content })
        } else {
          result.push({ role: 'user', content: textParts.join('\n') })
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content })
        continue
      }

      // Assistant message — may contain text + tool_use blocks
      const textParts: string[] = []
      const toolCalls: OpenAIToolCall[] = []

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text)
        } else if (block.type === 'thinking') {
          // Include thinking as prefixed text (OpenAI has no native thinking blocks)
          // Skip to avoid noise — the model will think internally via reasoning_effort
        } else if (block.type === 'tool_use') {
          const tuBlock = block as AnthropicToolUseBlock
          toolCalls.push({
            id: tuBlock.id,
            type: 'function',
            function: {
              name: tuBlock.name,
              arguments: JSON.stringify(tuBlock.input),
            },
          })
        }
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: textParts.join('\n') || null,
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls
      }
      result.push(assistantMsg)
    }
  }

  return result
}

/**
 * Convert Anthropic tool definitions → OpenAI function tools
 */
function translateTools(tools: AnthropicTool[] | undefined): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter(t => !t.type || t.type === 'custom') // skip server tools, computer_use etc.
    .map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
}

// ---------------------------------------------------------------------------
// OpenAI stream → Anthropic stream event translator
// ---------------------------------------------------------------------------

class OpenAIStreamToAnthropicStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private decoder = new TextDecoder()
  private buffer = ''
  private model: string
  private requestId: string
  private contentBlockIndex = 0
  private currentToolCalls: Map<number, { id: string; name: string; args: string }> = new Map()
  private hasStartedTextBlock = false
  private totalOutputTokens = 0
  private inputTokens = 0
  private finishReason: string | null = null
  private done = false

  // Implements the controller property check that claude.ts uses to
  // distinguish stream objects from error message objects.
  readonly controller = {} as AbortController

  constructor(
    private response: Response,
    model: string,
  ) {
    this.reader = response.body!.getReader()
    this.model = model
    this.requestId = response.headers.get('x-request-id') || generateId()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<BetaRawMessageStreamEvent> {
    // Emit message_start first
    yield {
      type: 'message_start',
      message: {
        id: this.requestId,
        type: 'message',
        role: 'assistant',
        content: [] as never[],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }

    // Read and parse SSE chunks
    while (!this.done) {
      const { done, value } = await this.reader.read()
      if (done) break

      this.buffer += this.decoder.decode(value, { stream: true })
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop()! // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue // skip empty lines and comments
        if (trimmed === 'data: [DONE]') {
          this.done = true
          break
        }
        if (trimmed.startsWith('data: ')) {
          const json = trimmed.slice(6)
          try {
            const chunk: OpenAIStreamChunk = JSON.parse(json)
            yield* this.processChunk(chunk)
          } catch {
            // skip malformed JSON
          }
        }
      }
    }

    // Close any open text block
    if (this.hasStartedTextBlock) {
      yield {
        type: 'content_block_stop',
        index: this.contentBlockIndex,
      }
      this.contentBlockIndex++
    }

    // Close any open tool call blocks
    for (const [, _tc] of this.currentToolCalls) {
      yield {
        type: 'content_block_stop',
        index: this.contentBlockIndex,
      }
      this.contentBlockIndex++
    }

    // Emit message_delta + message_stop
    yield {
      type: 'message_delta',
      delta: {
        stop_reason: this.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: this.totalOutputTokens },
    }

    yield { type: 'message_stop' }
  }

  private *processChunk(chunk: OpenAIStreamChunk): Generator<BetaRawMessageStreamEvent> {
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens || 0
      this.totalOutputTokens = chunk.usage.completion_tokens || 0
    }

    for (const choice of chunk.choices || []) {
      if (choice.finish_reason) {
        this.finishReason = choice.finish_reason
      }

      const delta = choice.delta

      // Text content
      if (delta.content) {
        if (!this.hasStartedTextBlock) {
          this.hasStartedTextBlock = true
          yield {
            type: 'content_block_start',
            index: this.contentBlockIndex,
            content_block: { type: 'text', text: '' as '' },
          }
        }
        yield {
          type: 'content_block_delta',
          index: this.contentBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        }
      }

      // Tool calls
      if (delta.tool_calls) {
        // Close text block before tool calls if open
        if (this.hasStartedTextBlock) {
          yield {
            type: 'content_block_stop',
            index: this.contentBlockIndex,
          }
          this.contentBlockIndex++
          this.hasStartedTextBlock = false
        }

        for (const tc of delta.tool_calls) {
          if (!this.currentToolCalls.has(tc.index)) {
            // New tool call starting
            const id = tc.id || generateToolCallId()
            const name = tc.function?.name || ''
            this.currentToolCalls.set(tc.index, { id, name, args: '' })

            yield {
              type: 'content_block_start',
              index: this.contentBlockIndex + tc.index,
              content_block: {
                type: 'tool_use',
                id,
                name,
                input: {} as Record<string, never>,
              },
            }
          }

          // Accumulate arguments
          if (tc.function?.arguments) {
            const existing = this.currentToolCalls.get(tc.index)!
            existing.args += tc.function.arguments
            yield {
              type: 'content_block_delta',
              index: this.contentBlockIndex + tc.index,
              delta: {
                type: 'input_json_delta',
                partial_json: tc.function.arguments,
              },
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main adapter class — duck-types as Anthropic SDK client
// ---------------------------------------------------------------------------

export class OpenAIAdapter {
  private apiKey: string
  private baseURL: string
  private organization?: string
  private defaultHeaders: Record<string, string>
  private timeout: number

  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        withResponse: () => Promise<{
          data: OpenAIStreamToAnthropicStream
          request_id: string
          response: Response
        }>
      }
    }
  }

  constructor(config: {
    apiKey?: string | null
    defaultHeaders?: Record<string, string>
    maxRetries?: number
    timeout?: number
    dangerouslyAllowBrowser?: boolean
    [key: string]: unknown
  }) {
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || ''
    this.baseURL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
    this.organization = process.env.OPENAI_ORGANIZATION
    this.defaultHeaders = config.defaultHeaders || {}
    this.timeout = config.timeout || 600_000

    // Bind the beta.messages.create method
    const self = this
    this.beta = {
      messages: {
        create(params: Record<string, unknown>, options?: Record<string, unknown>) {
          return {
            async withResponse() {
              const response = await self.makeRequest(params, options)
              const model = (params.model as string) || 'unknown'
              const stream = new OpenAIStreamToAnthropicStream(response, model)
              return {
                data: stream,
                request_id: response.headers.get('x-request-id') || generateId(),
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
    const model = resolveOpenAIModel(params.model as string)
    const messages = translateMessages(params.messages as AnthropicMessage[])
    const systemMessages = translateSystem(params.system as AnthropicSystemBlock[] | string | undefined)
    const tools = translateTools(params.tools as AnthropicTool[] | undefined)

    // Build OpenAI request body
    const body: Record<string, unknown> = {
      model,
      messages: [...systemMessages, ...messages],
      stream: true,
      stream_options: { include_usage: true },
    }

    // Max tokens
    const maxTokens = params.max_tokens as number | undefined
    if (maxTokens) {
      // o-series models use max_completion_tokens, others use max_tokens
      if (model.startsWith('o')) {
        body.max_completion_tokens = maxTokens
      } else {
        body.max_tokens = maxTokens
      }
    }

    // Tools
    if (tools && tools.length > 0) {
      body.tools = tools
      // Allow the model to choose when to use tools
      body.tool_choice = 'auto'
    }

    // Temperature — o-series doesn't support temperature
    if (!model.startsWith('o')) {
      const temp = params.temperature as number | undefined
      if (temp !== undefined) {
        body.temperature = temp
      }
    }

    // Reasoning effort for o-series models (map from thinking config)
    if (model.startsWith('o')) {
      const thinking = params.thinking as { type: string; budget_tokens?: number } | undefined
      if (thinking && thinking.type !== 'disabled') {
        // Map thinking budget to reasoning_effort
        body.reasoning_effort = 'high'
      }
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      ...this.defaultHeaders,
    }
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization
    }

    // Forward abort signal
    const signal = (options?.signal as AbortSignal) || undefined

    const controller = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => controller.abort())
    }

    // Timeout
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        const errorBody = await response.text()
        // Translate OpenAI errors to Anthropic-style errors for withRetry compatibility
        const status = response.status
        const error = new Error(`OpenAI API error ${status}: ${errorBody}`) as Error & {
          status: number
          error?: { type: string; message: string }
        }
        error.status = status
        try {
          const parsed = JSON.parse(errorBody)
          error.error = {
            type: status === 429 ? 'rate_limit_error' : status === 401 ? 'authentication_error' : 'api_error',
            message: parsed?.error?.message || errorBody,
          }
        } catch {
          error.error = { type: 'api_error', message: errorBody }
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

// ---------------------------------------------------------------------------
// Model mapping: Anthropic model IDs → OpenAI model IDs
// ---------------------------------------------------------------------------

const MODEL_MAP: Record<string, string> = {
  // Direct OpenAI model names (passthrough)
  'o3': 'o3',
  'o4-mini': 'o4-mini',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  'gpt-4.1-nano': 'gpt-4.1-nano',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'codex-mini': 'codex-mini-latest',

  // Map Claude model names → OpenAI equivalents
  // Opus (most capable) → o3
  'claude-opus-4-6': 'o3',
  'claude-opus-4-5': 'o3',
  'claude-opus-4-1': 'o3',
  'claude-opus-4': 'o3',

  // Sonnet (balanced) → gpt-4.1
  'claude-sonnet-4-6': 'gpt-4.1',
  'claude-sonnet-4-5': 'gpt-4.1',
  'claude-sonnet-4': 'gpt-4.1',
  'claude-3-7-sonnet': 'gpt-4.1',
  'claude-3-5-sonnet': 'gpt-4.1',

  // Haiku (fast) → gpt-4.1-mini
  'claude-haiku-4-5': 'gpt-4.1-mini',
  'claude-3-5-haiku': 'gpt-4.1-mini',
}

function resolveOpenAIModel(anthropicModel: string): string {
  // Check env override first
  const envModel = process.env.OPENAI_MODEL
  if (envModel) return envModel

  // Direct match
  if (MODEL_MAP[anthropicModel]) return MODEL_MAP[anthropicModel]

  // Prefix match (handles dated versions like claude-opus-4-6-20260101)
  for (const [prefix, mapped] of Object.entries(MODEL_MAP)) {
    if (anthropicModel.startsWith(prefix)) return mapped
  }

  // Provider-specific model strings (bedrock, vertex format) → strip provider prefix
  const stripped = anthropicModel
    .replace(/^us\.anthropic\./, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/@\d+$/, '')
  if (MODEL_MAP[stripped]) return MODEL_MAP[stripped]

  // If it looks like an OpenAI model already, pass through
  if (anthropicModel.startsWith('gpt-') || anthropicModel.startsWith('o') || anthropicModel.startsWith('codex-')) {
    return anthropicModel
  }

  // Default fallback
  return 'o3'
}

// Exported for use in model display
export { resolveOpenAIModel, MODEL_MAP }
