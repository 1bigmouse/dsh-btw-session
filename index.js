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
  /**
   * Images from the parent conversation that a side request may look at again.
   *
   * A screenshot the user sent earlier is usually the subject of the question, so
   * its durable reference is forwarded instead of the `[image attachment]`
   * placeholder. 0 keeps the placeholder-only behaviour.
   */
  maxContextImages: 3,
  /** Images one side question may attach; 0 turns image input off entirely. */
  maxImages: 6,
  /**
   * Image occurrences kept across one whole side request, newest first.
   *
   * Context images, replayed images, and the current question all count. Without
   * a cap, a thread that keeps asking about high-resolution screenshots would
   * grow its request without bound.
   */
  maxRequestImages: 8,
  /** Output cap for one side answer. Reasoning tokens count against it. */
  maxOutputTokens: 8192,
  /**
   * Read-only tools the side thread may call. Every name must be a registered
   * tool the session itself may use; mutating tools are never on this list.
   */
  tools: ['read', 'glob', 'grep'],
  /** Tool rounds allowed before the answer is returned as it stands. */
  maxToolRounds: 4,
  /**
   * One side answer's wall-clock budget, in milliseconds; 0 disables the timer.
   *
   * A provider that stops sending would otherwise leave the panel spinning with
   * no way out: the request holds the thread until it settles.
   */
  timeoutMs: 300_000,
  /** Optional fixed route; otherwise the parent session's own route is used. */
  route: null,
  /** Optional replacement for the side-question system prompt. */
  systemPrompt: null,
}

/**
 * Build the side-question instruction.
 *
 * The tool paragraph is conditional on purpose: promising tools the request does
 * not carry makes a model serialize the call as prose instead. The image line is
 * conditional for the same reason — a model told to look at pictures that are not
 * there tends to invent them.
 * @param hasTools - whether this request actually declares read-only tools.
 * @param imageCount - image occurrences this request carries.
 */
function systemPromptFor(hasTools, imageCount) {
  const lines = [
    'You are answering a quick side question ("/btw") about an ongoing coding session.',
    'The conversation below is that session\'s context, supplied read-only so you can answer accurately.',
  ]
  if (hasTools) {
    lines.push('Read-only file tools are available. Use them when the answer needs a file the context does not quote, and keep each lookup narrow.')
  } else {
    lines.push('You have no tools here. Answer from the conversation alone, and say when it is not enough.')
  }
  if (imageCount > 0) {
    lines.push(`This request carries ${imageCount === 1 ? 'one attached image' : `${imageCount} attached images`}; read them as part of the conversation rather than describing what a screenshot usually shows.`)
  }
  lines.push(
    'You cannot modify files, run commands, or change the workspace.',
    'Answer the question directly and concisely.',
    'If neither the context nor a lookup answers it, say so plainly instead of guessing.',
    'Reply in the language of the question.',
  )
  return lines.join('\n')
}

/**
 * Characters a model substitutes for the markup's ASCII separators.
 *
 * The token is a synthetic trigger, so a model that wants a tool it cannot have
 * re-invents the spelling: box-drawing bars, full-width bars, dotted bars, and
 * zero-width joiners all appear in real answers. Matching only `|` let one such
 * variant through and the panel rendered the raw call as the answer.
 */
const MARKUP_BAR_LOOKALIKES = /[\u2502\u2503\u23D0\uFF5C\u2223\u2225\u01C0\u2758\u007C]/g
/** Invisible characters that can split the token: zero-width, word joiner, BOM, soft hyphen. */
const MARKUP_NOISE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g

/**
 * Whether one line is tool-call markup a model wrote as prose.
 *
 * Two shapes are recognized: the `DSML` token itself, in any separator spelling,
 * and a malformed call whose tags carry a literal bar (`< / | invoke name=…>`).
 * Both mean the same thing — the provider did not turn the call into a block.
 * @param line - one line of the accumulated answer.
 */
function looksLikeToolMarkup(line) {
  const normalized = String(line ?? '')
    // Full-width punctuation and letters map back to ASCII: a model that renders
    // the token in a CJK-width font produces exactly that.
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(MARKUP_BAR_LOOKALIKES, '|')
    .replace(MARKUP_NOISE, '')
  if (/DSML/i.test(normalized)) return true
  return /<\s*\/?\s*\|/.test(normalized) && /(invoke|parameter|calls)\s+name\s*=/i.test(normalized)
}

/**
 * Drop tool-call markup a model wrote as prose.
 *
 * This fires only when the provider did not turn the call into `tool-call`
 * blocks. Showing raw markup as an answer helps nobody, so the call lines are
 * removed and the caller reports that the answer stayed context-only. An answer
 * that was entirely markup becomes empty, which the panel renders as a retryable
 * row instead of a wall of broken tags.
 * @param text - the accumulated answer text.
 * @returns the prose left behind and whether markup was removed.
 */
function withoutToolMarkup(text) {
  const lines = String(text ?? '').split('\n')
  const markup = lines.map(looksLikeToolMarkup)
  if (!markup.some(Boolean)) return { text, stripped: false }
  const kept = lines.filter((_line, index) => !markup[index])
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), stripped: true }
}

/** Roles that carry a parent-agent instruction; they are not reused for a side answer. */
const INSTRUCTION_ROLES = new Set(['system', 'developer'])

/**
 * Cut a derived history at the first tool call that never received a result.
 *
 * A turn still in flight has an assistant message whose calls have no results
 * yet. Replaying that prefix would hand the model a conversation that stops in
 * the middle of an action, so the side request uses only what already settled —
 * the same boundary OpenCode's `SessionHistory.preview` draws. Calls that were
 * answered later in the log are settled and stay.
 * @param messages - derived session messages in order.
 * @returns the messages before the first unresolved call.
 */
function settledMessages(messages) {
  const resolved = new Set()
  for (const message of messages) {
    if (message?.role === 'tool' && typeof message.toolCallId === 'string') resolved.add(message.toolCallId)
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (block?.type === 'tool-call' && typeof block.id === 'string' && !resolved.has(block.id)) {
        return messages.slice(0, index)
      }
    }
  }
  return messages
}

/** The stable key one snapshot row is addressed by; a retry names it. */
function exchangeKey(exchange, index) {
  return `${exchange.at}:${index}`
}

/** Why one attempt produced no answer, or null when it produced one. */
function failureReason(state) {
  if (state.timedOut) return 'timeout'
  if (state.aborted) return 'interrupted'
  if (state.answer !== '') return null
  if (state.thread.error !== null) return 'error'
  return null
}

/** The sentence a failed row carries; the panel shows it verbatim. */
function failureMessage(reason, thread, timeoutMs) {
  if (reason === 'timeout') {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    return `The model did not finish within ${seconds}s.`
  }
  if (reason === 'interrupted') return 'The request was cancelled.'
  return thread.error ?? 'The model call failed.'
}

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

/**
 * Split one parent message into the part a side request can reuse.
 *
 * Text is flattened to one string; image blocks keep their durable reference so
 * the side request can look at the picture itself rather than read
 * `[image attachment]`. Files are never forwarded: their bytes are addressed by
 * a reference only a tool can resolve.
 * @param message - one derived session message.
 * @returns the joined text and the image references in message order.
 */
function contextRow(message) {
  const parts = []
  const images = []
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block?.type === 'image' && block.attachment !== undefined) {
      images.push(block.attachment)
    } else if (block?.type === 'image') {
      parts.push('[image attachment]')
    } else if (block?.type === 'file') {
      parts.push(`[file attachment: ${block.attachment?.name ?? 'file'}]`)
    }
  }
  return { text: parts.join('\n').trim(), images }
}

/** Raster formats the attachment service accepts; the browser is told the same list. */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Normalize the images one browser submitted with a question.
 *
 * The wire shape is the one a prompt uses before admission — canonical base64
 * plus a declared media type — so nothing is decoded here; the attachment
 * service verifies the bytes against the declared type, and applies the
 * deployment's own count, byte, and pixel limits.
 * @param raw - untrusted `images` member of the request body.
 * @param limit - images one question may attach.
 * @returns accepted entries and one refusal reason, if any.
 */
function readImages(raw, limit) {
  if (raw === undefined || raw === null) return { images: [], refusal: null }
  if (!Array.isArray(raw)) return { images: [], refusal: 'malformed' }
  const images = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return { images: [], refusal: 'malformed' }
    const mediaType = typeof entry.mediaType === 'string' ? entry.mediaType : ''
    const data = typeof entry.data === 'string' ? entry.data : ''
    if (!IMAGE_MEDIA_TYPES.has(mediaType) || data === '') return { images: [], refusal: 'malformed' }
    images.push({
      type: 'image',
      mediaType,
      data,
      ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
    })
  }
  // A question without images never needs image support; only a real attempt is
  // refused, so turning the feature off leaves ordinary questions working.
  if (images.length === 0) return { images: [], refusal: null }
  if (limit <= 0) return { images: [], refusal: 'disabled' }
  if (images.length > limit) return { images: [], refusal: 'too-many' }
  return { images, refusal: null }
}

/**
 * Keep the newest `max` image occurrences of one request, text for the rest.
 *
 * The walk runs backwards because "which image is this about?" refers to the
 * latest one; dropping the oldest occurrence keeps the question answerable while
 * the request stays bounded.
 * @param messages - request messages in conversation order.
 * @param max - image occurrences to keep.
 * @returns new messages with the surplus occurrences replaced by a note.
 */
function limitRequestImages(messages, max) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
  let kept = 0
  const next = new Array(messages.length)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const content = Array.isArray(message?.content) ? message.content : null
    if (content === null) {
      next[index] = message
      continue
    }
    const blocks = []
    for (let position = content.length - 1; position >= 0; position -= 1) {
      const block = content[position]
      if (block?.type === 'image') {
        if (kept < limit) {
          kept += 1
          blocks.unshift(block)
        } else {
          blocks.unshift({ type: 'text', text: '[image from an earlier question omitted to fit the request limit]' })
        }
        continue
      }
      blocks.unshift(block)
    }
    next[index] = { ...message, content: blocks }
  }
  return { messages: next, images: kept }
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

/**
 * Build one user message from its text and the durable images it carries.
 * @param text - the question or the parent message's flattened text.
 * @param images - durable image references, in message order.
 */
function userMessage(text, images) {
  const content = text === '' ? [] : [{ type: 'text', text }]
  for (const ref of images ?? []) content.push({ type: 'image', attachment: ref })
  if (content.length === 0) content.push({ type: 'text', text: '' })
  return { id: randomId(), role: 'user', content, source: { kind: 'user' } }
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

/** One JSON-safe failure. */
function failure(code, message) {
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
      /** Monotone attempt number: a late result from an older attempt is stale. */
      attempt: 0,
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
   * Only conversational content survives: tool calls, tool-result protocol
   * messages, and the parent's own instruction messages are dropped so the
   * request stays a plain conversation with no tool schema. Images keep their
   * durable reference — a screenshot the user sent earlier is usually what the
   * side question is about — but only the newest `maxContextImages` of them.
   */
  buildContext(agent, route) {
    let derived = []
    try {
      derived = agent?.session?.deriveMessages?.() ?? []
    } catch {
      derived = []
    }
    // Only the settled prefix: a turn in flight has an assistant message whose
    // tool calls have no results yet, and that is not a conversation yet.
    derived = settledMessages(derived)
    const conversational = []
    for (const message of derived) {
      if (INSTRUCTION_ROLES.has(message?.role)) continue
      // An assistant row cannot carry a picture a model produced, so only user
      // and tool rows are asked for images.
      const row = contextRow(message)
      const images = message?.role === 'assistant' ? [] : row.images
      if (row.text === '' && images.length === 0) continue
      conversational.push({ role: message.role, text: row.text, images })
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
    const images = this.takeContextImages(kept)
    const messages = kept.map((row) => {
      const text = row.role === 'tool' ? `[tool result]\n${row.text}` : row.text
      if (row.images.length === 0) {
        return textMessage(row.role === 'assistant' ? 'assistant' : 'user', text, route)
      }
      return userMessage(text, row.images)
    })
    return { messages, count: kept.length, chars, images }
  }

  /**
   * Keep only the newest images of the context window, in place.
   *
   * The array is walked backwards so the most recent screenshot survives a
   * budget cut; a row left with neither text nor image becomes a placeholder
   * rather than an empty message.
   * @param rows - the kept context rows, oldest first.
   * @returns the number of images the context still carries.
   */
  takeContextImages(rows) {
    let budget = Math.max(0, Math.floor(Number(this.config.maxContextImages) || 0))
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]
      if (row.images.length === 0) continue
      const keep = budget <= 0 ? [] : row.images.slice(-budget)
      budget -= keep.length
      if (keep.length === row.images.length) continue
      row.images = keep
      if (row.text === '') row.text = '[image attachment]'
    }
    return rows.reduce((total, row) => total + row.images.length, 0)
  }

  /** The earlier exchanges of the side thread that this request replays. */
  replay(thread, route) {
    const limit = Math.max(0, Number(this.config.maxExchanges) || 0) * 2
    const tail = limit === 0 ? [] : thread.exchanges.slice(-limit)
    return tail.map(exchange => exchange.role === 'user'
      ? userMessage(exchange.text, exchange.attachments ?? [])
      : textMessage(exchange.role, exchange.text, route))
  }

  /** Images one side question may attach, or 0 when the feature is off. */
  maxImages() {
    const value = Number(this.config.maxImages)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }

  /**
   * Whether this activation can carry images, and the reason when it cannot.
   * The panel hides its attach control from this answer instead of failing late.
   */
  imageSupport() {
    const max = this.maxImages()
    if (max <= 0) return { enabled: false, max: 0, reason: 'disabled' }
    if (this.ctx.get('attachments') === undefined) return { enabled: false, max, reason: 'no-store' }
    return { enabled: true, max, reason: 'ok' }
  }

  /**
   * Store the images of one question and return their durable references.
   *
   * `admitPromptContent` is the same gate an ordinary prompt passes: it verifies
   * the declared media type against the decoded bytes and enforces the
   * deployment's image count, byte, and pixel limits, so a side question cannot
   * store more than a normal message may.
   */
  async admitImages(store, images, text) {
    const admitted = await store.admitPromptContent([
      { type: 'text', text },
      ...images,
    ])
    const refs = []
    for (const part of admitted) {
      if (part?.type === 'image' && part.attachment !== undefined) refs.push(part.attachment)
    }
    return refs
  }

  /** One image this thread already admitted, by attachment id. */
  imageOf(sessionId, attachmentId) {
    const thread = this.threads.get(sessionId)
    if (thread === undefined) return undefined
    for (const exchange of thread.exchanges) {
      for (const ref of exchange.attachments ?? []) {
        if (ref.attachmentId === attachmentId) return ref
      }
    }
    return undefined
  }

  /**
   * The read-only tools this side thread may call, and why the list is what it is.
   *
   * Resolution passes the **agent** as the scope. `ctx.tools` keeps one layered
   * view per scope (`ScopeKey` is an identity-compared object, and the Agent is
   * that key), and `ctx.tools.get(name)` with no scope reads the global view —
   * which is not the set this session may call. That mistake is why every side
   * request went out without tools.
   *
   * `executable(name, agent)` is used first because it also refuses
   * condition-gated registrations that a call outside a model step may not run;
   * `get` is the fallback for a registry that predates it.
   * @returns the model-facing schemas plus a stable reason for diagnostics.
   */
  planTools(agent) {
    const configured = Array.isArray(this.config.tools) ? this.config.tools : []
    const names = configured.filter(name => typeof name === 'string' && name !== '')
    if (names.length === 0) return { tools: [], reason: 'disabled' }
    const service = this.ctx.get('tools')
    if (service === undefined) return { tools: [], reason: 'no-registry' }
    const tools = []
    const skipped = []
    let reason = 'not-admitted'
    for (const name of names) {
      let definition
      try {
        definition = typeof service.executable === 'function'
          ? service.executable(name, agent)
          : service.get?.(name, agent)
      } catch {
        definition = undefined
      }
      if (definition === undefined) {
        skipped.push(name)
        continue
      }
      let parameters
      try {
        parameters = JSON.parse(JSON.stringify(definition.parameters ?? { type: 'object' }))
      } catch {
        skipped.push(name)
        reason = 'uncloneable'
        continue
      }
      tools.push({ name: definition.name, description: definition.description, parameters })
    }
    if (tools.length > 0) return { tools, reason: 'ok', skipped }
    return { tools, reason: skipped.length === 0 ? 'empty' : reason, skipped }
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

  /**
   * Consume one stream, folding prose, reasoning, usage, and settled calls.
   *
   * The loop and its closing pass differ only in the request they send, so the
   * reading is shared: one place decides what a chunk means, and the caller sees
   * the same numbers either way.
   * @param stream - the async chunk stream `ctx.llm.stream` returned.
   * @param sink - per-ask accumulation shared by every request of one question.
   * @returns the round's prose and the tool calls it settled.
   */
  async consumeStream(stream, sink) {
    let text = ''
    const calls = []
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') {
        if (sink.firstTokenAt === undefined && chunk.text !== '') sink.firstTokenAt = Date.now()
        text += chunk.text
      } else if (chunk?.type === 'reasoning-delta') {
        sink.reasoning += chunk.text
      } else if (chunk?.type === 'usage') {
        addUsage(sink.usage, chunk.usage)
      } else if (chunk?.type === 'block-end') {
        // The settled block is the only place a complete call appears; the
        // delta stream carries partial JSON.
        if (chunk.block?.type === 'tool-call') calls.push(chunk.block)
      } else if (chunk?.type === 'finish') {
        sink.finish = chunk.reason?.kind ?? 'stop'
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
          sink.error = chunk.reason.failure?.message ?? chunk.reason.kind
        }
      }
    }
    return { text, calls }
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
   * Ask one side question and record the exchange.
   *
   * Only caller mistakes (empty question, too many images, an answer already
   * running) are returned as failures, because the panel has to keep the draft
   * for those. Everything that happens once the model was called is recorded in
   * the thread — as an answer or as a retryable failed row — so a timeout or a
   * provider error can be acted on instead of vanishing.
   * @returns the JSON-safe result the browser receives.
   */
  async ask(sessionId, question, rawImages, signal) {
    const text = String(question ?? '').trim()
    if (text === '') return failure('empty-question', 'A side question must not be empty.')
    const wanted = readImages(rawImages, this.maxImages())
    if (wanted.refusal === 'disabled') {
      return failure('images-disabled', 'Image input is turned off for side questions.')
    }
    if (wanted.refusal === 'too-many') {
      return failure('too-many-images', `A side question may attach at most ${this.maxImages()} images.`)
    }
    if (wanted.refusal === 'malformed') {
      return failure('bad-image', 'One attached image is not a PNG, JPEG, WebP, or GIF.')
    }
    return this.run(sessionId, { text, encoded: wanted.images }, signal)
  }

  /**
   * Re-run one failed question in place.
   *
   * The question row is the record of what was asked, so a retry never asks the
   * panel to resend text or images: the same question is answered again and the
   * failed answer row is replaced. A successful row is not retryable.
   */
  async retry(sessionId, key, signal) {
    const thread = this.threads.get(sessionId)
    if (thread === undefined) return failure('no-thread', 'This session has no side thread to retry.')
    if (thread.busy) return failure('busy', 'A side answer is still running.')
    const index = thread.exchanges.findIndex((exchange, position) => exchangeKey(exchange, position) === key)
    const failed = index < 0 ? undefined : thread.exchanges[index]
    const question = index > 0 ? thread.exchanges[index - 1] : undefined
    if (failed === undefined || failed.role !== 'assistant'
      || question === undefined || question.role !== 'user') {
      return failure('no-exchange', 'That answer is no longer part of this side thread.')
    }
    if (failed.text !== '' && failed.failure === undefined) {
      return failure('answered', 'That answer already succeeded.')
    }
    return this.run(sessionId, {
      text: question.text,
      refs: question.attachments ?? [],
      replaceIndex: index,
      questionAt: question.at,
    }, signal)
  }

  /**
   * Run one attempt for a question and record its outcome.
   *
   * Callers reach this through `ask` (new question, base64 images) or `retry`
   * (existing question, already admitted references). The attempt number makes a
   * late result harmless: a closed panel or a newer attempt owns the thread, and
   * a stale run discards its result instead of rewriting the rows.
   */
  async run(sessionId, request, signal) {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return failure('session-not-live', 'This session has no live agent.')
    const route = this.routeOf(agent)
    if (route === undefined) return failure('no-route', 'No provider/model route is selected for this session.')
    const thread = this.threadOf(sessionId)
    if (thread.busy) return failure('busy', 'A side answer is still running.')

    const store = this.ctx.get('attachments')
    const encoded = Array.isArray(request.encoded) ? request.encoded : []
    if (encoded.length > 0 && store === undefined) {
      return failure('images-unsupported', 'This deployment has no attachment store, so a side question cannot carry images.')
    }

    const attempt = thread.attempt + 1
    thread.attempt = attempt
    const controller = new AbortController()
    let aborted = false
    const forwardAbort = () => { aborted = true; controller.abort() }
    signal?.addEventListener?.('abort', forwardAbort, { once: true })
    this.inflight.set(sessionId, controller)
    thread.busy = true
    thread.error = null
    thread.pending = null
    thread.updatedAt = Date.now()

    const timeoutMs = Math.max(0, Math.floor(Number(this.config.timeoutMs) || 0))
    let timedOut = false
    const timer = timeoutMs === 0 ? null : setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    const release = () => {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener?.('abort', forwardAbort)
      if (this.inflight.get(sessionId) === controller) this.inflight.delete(sessionId)
      if (thread.attempt === attempt) thread.busy = false
      thread.updatedAt = Date.now()
    }

    let images = []
    if (encoded.length > 0) {
      try {
        images = await this.admitImages(store, encoded, request.text)
      } catch (error) {
        release()
        return failure('image-refused', error instanceof Error ? error.message : String(error))
      }
    } else if (Array.isArray(request.refs)) {
      // A retry reuses the references the question already carries: they were
      // admitted once and are still the same stored objects.
      images = request.refs
    }

    const context = this.buildContext(agent, route)
    const plan = this.planTools(agent)
    const tools = plan.tools
    thread.toolPlan = {
      names: tools.map(tool => tool.name),
      reason: plan.reason,
      skipped: plan.skipped ?? [],
    }
    const allowedTools = new Set(tools.map(tool => tool.name))
    const built = limitRequestImages([
      ...context.messages,
      ...this.replay(thread, route),
      userMessage(request.text, images),
    ], this.config.maxRequestImages)
    const messages = built.messages
    const maxRounds = Math.max(0, Number(this.config.maxToolRounds) || 0)
    const startedAt = Date.now()
    let answer = ''
    let rounds = 0
    /** Calls the last allowed round asked for and never got to run. */
    let pendingCalls = 0
    const toolNames = []
    const usage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
    }
    /** Stream state shared by every round and the closing pass. */
    const sink = { usage, reasoning: '', finish: 'stop', firstTokenAt: undefined, error: null }
    const basePrompt = this.config.systemPrompt ?? systemPromptFor(tools.length > 0, built.images)

    try {
      for (let round = 0; round <= maxRounds; round += 1) {
        rounds += 1
        const { text, calls } = await this.consumeStream(this.ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          system: basePrompt,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
          ...(this.config.maxOutputTokens > 0 ? { maxTokens: this.config.maxOutputTokens } : {}),
          signal: controller.signal,
        }), sink)
        if (sink.error !== null) thread.error = sink.error

        // The last round that produced prose is the answer; earlier rounds talk
        // to themselves while gathering files.
        if (text.trim() !== '') answer = text.trim()
        if (calls.length === 0) break
        if (round >= maxRounds) {
          // The budget ran out while the model was still reading. The calls are
          // not executed: nothing after them may be appended to the request, or
          // the transcript would claim a lookup whose result never arrived.
          pendingCalls = calls.length
          break
        }

        const callBlocks = calls.map(call => ({
          type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments,
        }))
        messages.push(assistantMessage([
          ...(text === '' ? [] : [{ type: 'text', text }]),
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

      // A question that used up its tool rounds still deserves an answer. One
      // final pass runs without tools, so the model cannot ask for another
      // lookup, and its prompt says to answer from what it already read. Without
      // this, a model that keeps reading returns an empty answer with every read
      // already counted — which reads as "the panel is broken".
      if (pendingCalls > 0) {
        rounds += 1
        // A system note alone is easy for a model mid-investigation to ignore: it
        // answers by writing the call it wanted as prose. A trailing user turn
        // that says the tools are gone is what actually changes the reply.
        const closingMessages = [
          ...messages,
          userMessage('No tools are available now. Answer the question above in prose from what you have already read.', []),
        ]
        const closing = await this.consumeStream(this.ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
          system: `${basePrompt}\nThe tool budget for this question is spent after ${toolNames.length} lookups, and no further lookup can run. Answer now from what you have already read, and say what is still unknown if the question needs it.`,
          messages: closingMessages,
          ...(this.config.maxOutputTokens > 0 ? { maxTokens: this.config.maxOutputTokens } : {}),
          signal: controller.signal,
        }), sink)
        if (sink.error !== null) thread.error = sink.error
        if (closing.text.trim() !== '') answer = closing.text.trim()
      }
    } catch (error) {
      thread.error = error instanceof Error ? error.message : String(error)
      sink.finish = 'error'
    } finally {
      release()
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
      contextImages: context.images,
      requestImages: built.images,
      askedImages: images.length,
      replayedExchanges: Math.floor(thread.exchanges.length / 2),
      llmMs: endedAt - startedAt,
      ttftMs: sink.firstTokenAt === undefined ? null : sink.firstTokenAt - startedAt,
      outputChars: answer.length,
      reasoningChars: sink.reasoning.length,
      rounds,
      toolCalls: toolNames.length,
      toolNames: [...new Set(toolNames)],
      toolMarkup: cleaned.stripped,
      /** True when the tool budget ran out and the closing pass had to answer. */
      toolBudgetExhausted: pendingCalls > 0,
      droppedCalls: pendingCalls,
      finish: sink.finish,
      route: `${route.provider}/${route.model}`,
      answeredAt: endedAt,
    }

    // A late result must not rewrite a thread that moved on: the panel may have
    // been closed, and a newer attempt may already own the rows.
    if (this.threads.get(sessionId) !== thread || thread.attempt !== attempt) {
      return { ok: true, stale: true, snapshot: this.snapshot(sessionId) }
    }

    const reason = failureReason({ timedOut, aborted, answer, thread })
    const answered = answer !== '' && reason === null
    const row = {
      role: 'assistant',
      text: answer,
      at: endedAt,
      measurement,
      ...(reason === null ? {} : { failure: { reason, message: failureMessage(reason, thread, timeoutMs) } }),
    }
    if (request.replaceIndex !== undefined && thread.exchanges[request.replaceIndex] !== undefined) {
      // A retry replaces the failed row instead of appending a second answer to
      // the same question.
      thread.exchanges[request.replaceIndex] = row
    } else {
      // The image references ride with the question row so a replayed request
      // sends the same pictures again and the panel can draw them.
      thread.exchanges.push({ role: 'user', text: request.text, at: request.questionAt ?? startedAt, attachments: images })
      thread.exchanges.push(row)
    }
    // Usage is counted even when no prose came back: those tokens were billed.
    accumulate(thread.totals, measurement)
    if (!answered) thread.totals.failed += 1
    thread.totals.asks = thread.exchanges.filter(exchange => exchange.role === 'user').length
    thread.updatedAt = Date.now()
    return { ok: true, snapshot: this.snapshot(sessionId), measurement, failure: row.failure ?? null }
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
        images: this.imageSupport(),
        limits: this.limits(),
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
        key: exchangeKey(exchange, index),
        role: exchange.role,
        text: exchange.text,
        at: exchange.at,
        metrics: exchange.measurement ?? null,
        attachments: exchange.attachments ?? [],
        failure: exchange.failure ?? null,
      })),
      totals: { ...thread.totals },
      tools: thread.toolPlan ?? { names: [], reason: 'idle' },
      route: route === undefined ? null : { provider: route.provider, model: route.model },
      images: this.imageSupport(),
      limits: this.limits(),
    }
  }

  /** The budget numbers the panel's footer explains. */
  limits() {
    return {
      maxExchanges: this.config.maxExchanges,
      maxContextMessages: this.config.maxContextMessages,
      maxContextChars: this.config.maxContextChars,
      maxImages: this.maxImages(),
    }
  }
}

/** A zeroed metrics bucket. */
function emptyTotals() {
  return {
    asks: 0,
    failed: 0,
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
        // `/btw` with no question opens the ask surface instead of complaining:
        // the panel has a composer, and that is where a side question is typed.
        return { kind: 'success', text: 'Btw panel opened — type the side question there.' }
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
        return json(await service.ask(body.sessionId, body.question, body.images, controller.signal))
      },
    }), 'btw: ask route')

    // A failed row can be answered again without resending the question.
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/btw/retry',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const body = await readBody(request)
        if (typeof body.sessionId !== 'string' || body.sessionId === '') {
          return json(failure('missing-session', 'A session id is required.'), 400)
        }
        if (typeof body.key !== 'string' || body.key === '') {
          return json(failure('missing-exchange', 'An answer key is required.'), 400)
        }
        const controller = new AbortController()
        request.signal?.addEventListener?.('abort', () => { controller.abort() }, { once: true })
        return json(await service.retry(body.sessionId, body.key, controller.signal))
      },
    }), 'btw: retry route')

    // The panel draws a question's pictures from this route. Only references the
    // thread already admitted are served, so it cannot be used to read arbitrary
    // stored objects of the profile.
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/btw/image',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const query = new URL(request.url).searchParams
        const sessionId = query.get('session')
        const attachmentId = query.get('attachment')
        if (sessionId === null || sessionId === '' || attachmentId === null || attachmentId === '') {
          return json(failure('missing-image', 'A session id and an attachment id are required.'), 400)
        }
        const ref = service.imageOf(sessionId, attachmentId)
        if (ref === undefined) return json(failure('unknown-image', 'That image is not part of this side thread.'), 404)
        const store = service.ctx.get('attachments')
        if (store === undefined) return json(failure('images-unsupported', 'This deployment has no attachment store.'), 404)
        try {
          const stored = await store.readImage(ref)
          return new Response(stored.data, {
            headers: {
              'content-type': stored.ref.mediaType,
              'cache-control': 'private, max-age=600',
            },
          })
        } catch (error) {
          return json(failure('image-unavailable', error instanceof Error ? error.message : String(error)), 404)
        }
      },
    }), 'btw: image route')

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
