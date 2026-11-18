/**
 * Host half of the Btw side-question bundle.
 *
 * A side question ("/btw") is answered with the current session's context as a
 * one-shot snapshot, but nothing about it reaches the parent session: no inbox
 * message, no turn, no assistant message, no tool call. The answer lives only in
 * this process's memory, per parent session, and is dropped when the user closes
 * the temporary thread. That is why the request is issued through `ctx.llm`
 * rather than through a second agent: an agent would commit its own session to
 * the durable log, and requirement is that closing the panel leaves nothing.
 *
 * The browser reaches this service through three exact Fetch routes on the
 * authenticated `/api` channel, because a third-party bundle is not part of the
 * generated Remote assembly.
 */

/** Services this plugin needs before it activates. */
export const inject = ['agents', 'llm', 'commands', 'tools']

/** Tunables; every value is overridable from the row's `config` in `cordis.patch.yml`. */
const DEFAULT_CONFIG = {
  /**
   * How many earlier exchanges of the side thread are replayed with a new
   * question, matching the established `/btw` behaviour in other agents.
   */
  maxExchanges: 20,
  /** Upper bound on parent-context messages included in one side request. */
  maxContextMessages: 80,
  /** Upper bound on parent-context characters, oldest messages dropped first. */
  maxContextChars: 48000,
  /** Output cap for one side answer. Reasoning tokens count against it. */
  maxOutputTokens: 8192,
  /**
   * Read-only tools the side thread may call. Every name must be a registered
   * tool the session itself may use; mutating tools are never on this list.
   */
  tools: ['read', 'glob', 'grep'],
  /** Tool rounds allowed before the answer is returned as it stands. */
  maxToolRounds: 4,
  /** Optional fixed route; otherwise the parent session's own route is used. */
  route: null,
  /** Optional replacement for the side-question system prompt. */
  systemPrompt: null,
}

/**
 * Build the side-question instruction.
 *
 * The tool paragraph is conditional on purpose: promising tools the request does
 * not carry makes a model serialize the call as prose instead.
 * @param hasTools - whether this request actually declares read-only tools.
 */
function systemPromptFor(hasTools) {
  return [
    'You are answering a quick side question ("/btw") about an ongoing coding session.',
    'The conversation below is that session\'s context, supplied read-only so you can answer accurately.',
    hasTools
      ? 'Read-only file tools are available. Use them when the answer needs a file the context does not quote, and keep each lookup narrow.'
      : 'You have no tools here. Answer from the conversation alone, and say when it is not enough.',
    'You cannot modify files, run commands, or change the workspace.',
    'Answer the question directly and concisely.',
    'If neither the context nor a lookup answers it, say so plainly instead of guessing.',
    'Reply in the language of the question.',
  ].join('\n')
}

/** The markup a model falls back to when it decides to call a tool the request never declared. */
const TOOL_MARKUP = /\|\s*DSML\s*\|/i

/**
 * Drop tool-call markup a model wrote as prose.
 *
 * This fires only when the provider did not turn the call into `tool-call`
 * blocks. Showing raw markup as an answer helps nobody, so the call lines are
 * removed and the caller reports that the answer stayed context-only.
 * @param text - the accumulated answer text.
 * @returns the prose left behind and whether markup was removed.
 */
function withoutToolMarkup(text) {
  if (!TOOL_MARKUP.test(text)) return { text, stripped: false }
  const kept = text.split('\n').filter(line => !TOOL_MARKUP.test(line))
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), stripped: true }
}

/** Roles that carry a parent-agent instruction; they are not reused for a side answer. */
const INSTRUCTION_ROLES = new Set(['system', 'developer'])

/** Resolve the configuration for one activation. */
function resolveConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (raw !== null && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const value = raw[key]
      if (value === undefined) continue
      config[key] = value
    }
  }
  return config
}

/** Read one message's plain text, ignoring blocks a text-only side request cannot carry. */
function messageText(message) {
  const parts = []
  for (const block of message.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block?.type === 'image') {
      parts.push('[image attachment]')
    } else if (block?.type === 'file') {
      parts.push(`[file attachment: ${block.attachment?.name ?? 'file'}]`)
    }
  }
  return parts.join('\n').trim()
}

/** A fresh message identity in the same form the harness mints. */
function randomId() {
  const crypto = globalThis.crypto
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID()
  return `btw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Build one text-only conversation message in the request vocabulary.
 *
 * Assistant messages must carry the producer identity the session log records,
 * so the side request is assembled from complete messages rather than bare
 * role/content pairs.
 */
function textMessage(role, text, route) {
  const content = [{ type: 'text', text }]
  if (role === 'assistant') {
    return {
      id: randomId(),
      role: 'assistant',
      content,
      source: { kind: 'model', provider: route.provider, model: route.model },
    }
  }
  return { id: randomId(), role: 'user', content, source: { kind: 'user' } }
}

/** Build one assistant message carrying a round's prose and/or its tool calls. */
function assistantMessage(blocks, route) {
  return {
    id: randomId(),
    role: 'assistant',
    content: blocks,
    source: { kind: 'model', provider: route.provider, model: route.model },
  }
}

/** Build the tool-role message one settled call feeds back to the model. */
function toolResultMessage(callId, result) {
  const content = Array.isArray(result?.content) && result.content.length > 0
    ? result.content
    : [{ type: 'text', text: result?.isError === true ? 'The tool call failed.' : 'The tool returned no content.' }]
  return {
    id: randomId(),
    role: 'tool',
    content,
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...(result?.isError === true ? { isError: true } : {}),
  }
}

/** Fold one stream's usage report into the per-ask bucket. */
function addUsage(bucket, usage) {
  if (usage === null || typeof usage !== 'object') return
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) bucket[key] += value
  }
  add('inputTokens', usage.inputTokens)
  add('outputTokens', usage.outputTokens)
  add('cacheReadTokens', usage.cacheReadTokens)
  add('cacheWriteTokens', usage.cacheWriteTokens)
  add('reasoningTokens', usage.reasoningTokens)
  add('totalTokens', usage.totalTokens ?? numberOr(usage.inputTokens, 0) + numberOr(usage.outputTokens, 0))
}

/** One JSON-safe failure. */function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/**
 * Host service owning every live side thread.
 *
 * One instance per plugin activation; threads are keyed by the parent session
 * they were opened from, so each session's temporary conversation is separate.
 */
class BtwService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, object>} */
    this.threads = new Map()
    /** @type {Map<string, AbortController>} */
    this.inflight = new Map()
  }

  /** Create an empty thread value; nothing is retained outside this map. */
  emptyThread(sessionId) {
    const now = Date.now()
    return {
      sessionId,
      createdAt: now,
      updatedAt: now,
      exchanges: [],
      pending: null,
      busy: false,
      error: null,
      totals: emptyTotals(),
    }
  }

  /** Read the thread for one session, creating it on first use. */
  threadOf(sessionId) {
    let thread = this.threads.get(sessionId)
    if (thread === undefined) {
      thread = this.emptyThread(sessionId)
      this.threads.set(sessionId, thread)
    }
    return thread
  }

  /** The live agent driving one session, or undefined when it is not running here. */
  agentOf(sessionId) {
    const agents = this.ctx.get('agents')
    return agents?.get?.(sessionId)
  }

  /** Resolve the provider/model route for one side request. */
  routeOf(agent) {
    const fixed = this.config.route
    if (fixed !== null && typeof fixed === 'object' && fixed.provider && fixed.model) {
      return { provider: fixed.provider, model: fixed.model, reasoningEffort: fixed.reasoningEffort }
    }
    const selected = agent?.model?.current?.()
    if (selected !== undefined && selected !== null && selected.provider && selected.model) {
      return { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort }
    }
    const fallback = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    if (fallback !== undefined && fallback !== null && fallback.provider && fallback.model) {
      return { provider: fallback.provider, model: fallback.model, reasoningEffort: fallback.reasoningEffort }
    }
    return undefined
  }

  /**
   * Snapshot the parent conversation as read-only side-request context.
   *
   * Only conversational text survives: tool calls, tool-result protocol
   * messages, and the parent's own instruction messages are dropped so the
   * request stays a plain text conversation with no tool schema.
   */
  buildContext(agent, route) {
    let derived = []
    try {
      derived = agent?.session?.deriveMessages?.() ?? []
    } catch {
      derived = []
    }
    const conversational = []
    for (const message of derived) {
      if (INSTRUCTION_ROLES.has(message?.role)) continue
      const text = messageText(message)
      if (text === '') continue
      conversational.push({ role: message.role, text })
    }
    const windowed = conversational.slice(-this.config.maxContextMessages)
    // Trim from the oldest end until the character budget is respected.
    let chars = windowed.reduce((sum, row) => sum + row.text.length, 0)
    let first = 0
    while (first < windowed.length - 1 && chars > this.config.maxContextChars) {
      chars -= windowed[first].text.length
      first += 1
    }
    const kept = windowed.slice(first)
    const messages = kept.map(row => textMessage(
      row.role === 'assistant' ? 'assistant' : 'user',
      row.role === 'tool' ? `[tool result]\n${row.text}` : row.text,
      route,
    ))
    return { messages, count: kept.length, chars }
  }

  /** The earlier exchanges of the side thread that this request replays. */
  replay(thread, route) {
    const limit = Math.max(0, Number(this.config.maxExchanges) || 0) * 2
    const tail = limit === 0 ? [] : thread.exchanges.slice(-limit)
    return tail.map(exchange => textMessage(exchange.role, exchange.text, route))
  }

  /**
   * The read-only tools this side thread may call, and why the list is what it is.
   *
   * Looked up one name at a time rather than through `ctx.tools.schemas()`: that
   * call projects the whole registry and throws if any single tool's parameters
   * cannot be detached, which would silently leave this request with no tools at
   * all. A `defineTool` definition already stores JSON Schema, so one definition
   * is all that is needed.
   *
   * The list is also intersected with the tools the parent session's last request
   * actually offered, so a preset that hides `read` from the session hides it
   * here too.
   * @returns the model-facing schemas plus a stable reason for diagnostics.
   */
  planTools(agent) {
    const configured = Array.isArray(this.config.tools) ? this.config.tools : []
    const names = configured.filter(name => typeof name === 'string' && name !== '')
    if (names.length === 0) return { tools: [], reason: 'disabled' }
    const service = this.ctx.get('tools')
    if (service === undefined) return { tools: [], reason: 'no-registry' }
    const offered = new Set()
    try {
      for (const tool of agent?.session?.toolHistory?.()?.tools ?? []) offered.add(tool.name)
    } catch {
      // No completed request yet: judge by the registry alone.
    }
    const tools = []
    let skipped = 0
    for (const name of names) {
      if (offered.size > 0 && !offered.has(name)) { skipped += 1; continue }
      let definition
      try {
        definition = service.get?.(name)
      } catch {
        definition = undefined
      }
      if (definition === undefined) { skipped += 1; continue }
      let parameters
      try {
        parameters = JSON.parse(JSON.stringify(definition.parameters ?? { type: 'object' }))
      } catch {
        skipped += 1
        continue
      }
      tools.push({ name: definition.name, description: definition.description, parameters })
    }
    if (tools.length > 0) return { tools, reason: 'ok' }
    return { tools, reason: skipped > 0 ? 'unavailable' : 'empty' }
  }

  /**
   * Run one round's tool calls and return the results by call id.
   *
   * Execution omits the batch `log` field, so the owning session receives no
   * `tool/call` or `tool/result` events: the same tools run against the same
   * sandbox, and the parent transcript stays untouched. A name outside the
   * whitelist never executes.
   */
  async runCalls(agent, calls, allowed, signal, thread) {
    const results = new Map()
    const permitted = calls.filter(call => allowed.has(call.name))
    const service = this.ctx.get('tools')
    if (permitted.length > 0 && service !== undefined) {
      try {
        const batch = await service.execute({ calls: permitted, signal, agent })
        for (const entry of batch?.results ?? []) results.set(entry.callId, entry.result)
      } catch (error) {
        // A drained batch still carries the results it committed before failing.
        for (const entry of error?.partial?.results ?? []) results.set(entry.callId, entry.result)
        thread.error = error instanceof Error ? error.message : String(error)
      }
    }
    return results
  }

  /** Queue a question from a human command; the panel performs the request. */
  enqueue(agent, question) {
    const thread = this.threadOf(agent.id)
    thread.pending = question
    thread.error = null
    thread.updatedAt = Date.now()
    return this.snapshot(agent.id)
  }

  /**
   * Answer one side question and add the exchange to the temporary thread.
   * @returns the JSON-safe result the browser receives.
   */
  async ask(sessionId, question, signal) {
    const text = String(question ?? '').trim()
    if (text === '') return failure('empty-question', 'A side question must not be empty.')
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return failure('session-not-live', 'This session has no live agent.')
    const route = this.routeOf(agent)
    if (route === undefined) return failure('no-route', 'No provider/model route is selected for this session.')
    const thread = this.threadOf(sessionId)
    if (thread.busy) return failure('busy', 'A side answer is still running.')

    const controller = new AbortController()
    const forwardAbort = () => { controller.abort() }
    signal?.addEventListener?.('abort', forwardAbort, { once: true })
    this.inflight.set(sessionId, controller)
    thread.busy = true
    thread.error = null
    thread.pending = null
    thread.updatedAt = Date.now()

    const context = this.buildContext(agent, route)
    const plan = this.planTools(agent)
    const tools = plan.tools
    thread.toolPlan = { names: tools.map(tool => tool.name), reason: plan.reason }
    const allowedTools = new Set(tools.map(tool => tool.name))
    const messages = [
      ...context.messages,
      ...this.replay(thread, route),
      textMessage('user', text, route),
    ]
    const maxRounds = Math.max(0, Number(this.config.maxToolRounds) || 0)
    const startedAt = Date.now()
    let firstTokenAt
    let answer = ''
    let reasoning = ''
    let finishKind = 'stop'
    let rounds = 0
    const toolNames = []
    const usage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
    }

    try {
      for (let round = 0; round <= maxRounds; round += 1) {
        rounds += 1
        let roundText = ''
        const calls = []
        const stream = this.ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          system: this.config.systemPrompt ?? systemPromptFor(tools.length > 0),
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(this.config.maxOutputTokens > 0 ? { maxTokens: this.config.maxOutputTokens } : {}),
          signal: controller.signal,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') {
            if (firstTokenAt === undefined && chunk.text !== '') firstTokenAt = Date.now()
            roundText += chunk.text
          } else if (chunk?.type === 'reasoning-delta') {
            reasoning += chunk.text
          } else if (chunk?.type === 'usage') {
            addUsage(usage, chunk.usage)
          } else if (chunk?.type === 'block-end') {
            // The settled block is the only place a complete call appears; the
            // delta stream carries partial JSON.
            if (chunk.block?.type === 'tool-call') calls.push(chunk.block)
          } else if (chunk?.type === 'finish') {
            finishKind = chunk.reason?.kind ?? 'stop'
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              thread.error = chunk.reason.failure?.message ?? chunk.reason.kind
            }
          }
        }

        // The last round that produced prose is the answer; earlier rounds talk
        // to themselves while gathering files.
        if (roundText.trim() !== '') answer = roundText.trim()
        if (calls.length === 0) break
        if (round >= maxRounds) break

        const callBlocks = calls.map(call => ({
          type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments,
        }))
        messages.push(assistantMessage([
          ...(roundText === '' ? [] : [{ type: 'text', text: roundText }]),
          ...callBlocks,
        ], route))

        const executed = await this.runCalls(agent, callBlocks, allowedTools, controller.signal, thread)
        for (const call of callBlocks) {
          toolNames.push(call.name)
          messages.push(toolResultMessage(call.id, executed.get(call.id) ?? {
            content: [{ type: 'text', text: `Tool "${call.name}" is not available in this side session.` }],
            isError: true,
          }))
        }
      }
    } catch (error) {
      thread.error = error instanceof Error ? error.message : String(error)
      finishKind = 'error'
    } finally {
      signal?.removeEventListener?.('abort', forwardAbort)
      this.inflight.delete(sessionId)
      thread.busy = false
    }

    const endedAt = Date.now()
    // A provider that cannot turn the call into blocks leaves markup in the
    // prose; drop it and report that the answer stayed context-only.
    const cleaned = withoutToolMarkup(answer)
    answer = cleaned.text
    const measurement = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens || usage.inputTokens + usage.outputTokens,
      contextMessages: context.count,
      contextChars: context.chars,
      replayedExchanges: thread.exchanges.length / 2,
      llmMs: endedAt - startedAt,
      ttftMs: firstTokenAt === undefined ? null : firstTokenAt - startedAt,
      outputChars: answer.length,
      reasoningChars: reasoning.length,
      rounds,
      toolCalls: toolNames.length,
      toolNames: [...new Set(toolNames)],
      toolMarkup: cleaned.stripped,
      finish: finishKind,
      route: `${route.provider}/${route.model}`,
      answeredAt: endedAt,
    }
    // A completed ask is always recorded, even when it produced no prose. An
    // empty thread is indistinguishable from a broken panel, so the exchange
    // carries the reason and the panel renders it. A hard provider failure with
    // no text is different: it returns a failure so the question can be retried.
    if (answer !== '' || thread.error === null) {
      thread.exchanges.push({ role: 'user', text, at: startedAt })
      thread.exchanges.push({ role: 'assistant', text: answer, at: endedAt, measurement })
      if (answer !== '') accumulate(thread.totals, measurement)
    }
    thread.totals.asks = Math.floor(thread.exchanges.length / 2)
    thread.updatedAt = Date.now()
    if (thread.error !== null && answer === '') {
      return failure('llm-failure', thread.error)
    }
    return { ok: true, snapshot: this.snapshot(sessionId), measurement }
  }

  /** Drop one session's temporary thread; nothing about it is retained anywhere. */
  close(sessionId) {
    this.inflight.get(sessionId)?.abort()
    this.inflight.delete(sessionId)
    const existed = this.threads.delete(sessionId)
    return { ok: true, cleared: existed }
  }

  /** The JSON-safe value the panel renders. */
  snapshot(sessionId) {
    const thread = this.threads.get(sessionId)
    const agent = this.agentOf(sessionId)
    const route = agent === undefined ? undefined : this.routeOf(agent)
    if (thread === undefined) {
      return {
        ok: true,
        sessionId,
        open: false,
        busy: false,
        pending: null,
        error: null,
        messages: [],
        totals: emptyTotals(),
        route: route === undefined ? null : { provider: route.provider, model: route.model },
        limits: {
          maxExchanges: this.config.maxExchanges,
          maxContextMessages: this.config.maxContextMessages,
        },
      }
    }
    return {
      ok: true,
      sessionId,
      open: true,
      busy: thread.busy,
      pending: thread.pending,
      error: thread.error,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      messages: thread.exchanges.map((exchange, index) => ({
        key: `${exchange.at}:${index}`,
        role: exchange.role,
        text: exchange.text,
        at: exchange.at,
        metrics: exchange.measurement ?? null,
      })),
      totals: { ...thread.totals },
      tools: thread.toolPlan ?? { names: [], reason: 'idle' },
      route: route === undefined ? null : { provider: route.provider, model: route.model },
      limits: {
        maxExchanges: this.config.maxExchanges,
        maxContextMessages: this.config.maxContextMessages,
      },
    }
  }
}

/** A zeroed metrics bucket. */
function emptyTotals() {
  return {
    asks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    contextChars: 0,
    llmMs: 0,
    ttftMs: 0,
    outputChars: 0,
  }
}

/** Fold one answer's measurement into the thread's running totals. */
function accumulate(totals, measurement) {
  totals.inputTokens += measurement.inputTokens
  totals.outputTokens += measurement.outputTokens
  totals.cacheReadTokens += measurement.cacheReadTokens
  totals.cacheWriteTokens += measurement.cacheWriteTokens
  totals.reasoningTokens += measurement.reasoningTokens
  totals.totalTokens += measurement.totalTokens
  totals.contextChars += measurement.contextChars
  totals.llmMs += measurement.llmMs
  totals.ttftMs += measurement.ttftMs ?? 0
  totals.outputChars += measurement.outputChars
}

/** Coerce a possibly absent provider number. */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Answer one request with JSON. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Read a JSON object body, tolerating an empty one. */
async function readBody(request) {
  try {
    const parsed = await request.json()
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Register the plugin.
 * @param ctx - the Cordis context owning this activation.
 * @param rawConfig - the Loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const service = new BtwService(ctx, config)
  ctx.effect(() => () => {
    for (const controller of service.inflight.values()) controller.abort()
    service.inflight.clear()
    service.threads.clear()
  }, 'btw: drop temporary threads')

  // A human types `/btw <question>`: the question is queued here and answered by
  // the panel, so a command run never blocks the composer on a model call.
  ctx.effect(() => ctx.commands.register({
    name: 'btw',
    description: 'Ask a side question without adding it to this conversation',
    input: { hint: '<question>' },
    recordInput: false,
    handler: ({ agent, rawInput }) => {
      const question = String(rawInput ?? '').trim()
      if (question === '') {
        return { kind: 'error', text: 'Usage: /btw <question>' }
      }
      service.enqueue(agent, question)
      // Deliberately constant: the session log keeps no question or answer text.
      return { kind: 'success', text: 'Btw panel opened — the answer stays out of this conversation.' }
    },
  }), 'btw: /btw command')

  // The browser reaches this service over the authenticated `/api` channel.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/btw/state',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const sessionId = new URL(request.url).searchParams.get('session')
        if (sessionId === null || sessionId === '') return json(failure('missing-session', 'A session id is required.'), 400)
        return json(service.snapshot(sessionId))
      },
    }), 'btw: state route')

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/btw/ask',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readBody(request)
        if (typeof body.sessionId !== 'string' || body.sessionId === '') {
          return json(failure('missing-session', 'A session id is required.'), 400)
        }
        const controller = new AbortController()
        request.signal?.addEventListener?.('abort', () => { controller.abort() }, { once: true })
        return json(await service.ask(body.sessionId, body.question, controller.signal))
      },
    }), 'btw: ask route')

    scope.effect(() => scope.connection.fetch.register({
      path: '/api/btw/close',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readBody(request)
        if (typeof body.sessionId !== 'string' || body.sessionId === '') {
          return json(failure('missing-session', 'A session id is required.'), 400)
        }
        return json(service.close(body.sessionId))
      },
    }), 'btw: close route')
  })
}
