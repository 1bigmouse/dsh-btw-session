/**
 * Offline verification for the Btw bundle.
 *
 * Loads both halves against stub Cordis contexts, so the Host command, the
 * three Fetch routes, the request assembly, the metrics fold, and the Client
 * registrations are exercised without a browser.
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** The bundle root, one directory above this test. */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail })
}

// ---------------------------------------------------------------- Host half

const commands = new Map()
const routes = new Map()
const disposers = []
let llmCalls = []
/** `plain` answers from context alone; `tools` runs one read round first. */
let llmMode = 'plain'
/** Position of the next streamed call inside the ask being tested. */
let llmRound = 0
/** Whether the parent conversation currently ends in an unresolved tool call. */
let inFlightTurn = false

function makeEffectHost() {
  return {
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    inject(_names, callback) {
      return callback(effectScope())
    },
    get(name) {
      return services.get(name)
    },
  }
}

function effectScope() {
  const scope = {
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get(name) {
      return services.get(name)
    },
  }
  // Cordis exposes each injected service as a property of the injected scope.
  for (const [name, value] of services) {
    if (!(name in scope)) scope[name] = value
  }
  return scope
}

/** Session events a side request must never produce. */
const sessionAppends = []
/** Every tool batch the side thread asked the executor to run. */
const toolBatches = []

const fakeAgent = {
  id: 'sess-1',
  model: { current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  session: {
    toolHistory: () => ({ tools: [{ name: 'read' }, { name: 'glob' }, { name: 'grep' }] }),
    append: (...args) => {
      sessionAppends.push(args)
      return { seq: sessionAppends.length }
    },
    deriveMessages: () => [
      { id: 'm1', role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }], source: { kind: 'system-prompt' } },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: 'Build me a parser.' }], source: { kind: 'user' } },
      {
        id: 'm3',
        role: 'assistant',
        content: [{ type: 'text', text: 'Sure.' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      { id: 'm4', role: 'tool', content: [{ type: 'text', text: 'file contents' }], source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1' },
      { id: 'm5', role: 'user', content: [
        { type: 'text', text: 'Now add tests.' },
        // A screenshot the user sent earlier: the side request may look at it.
        { type: 'image', attachment: CONTEXT_IMAGE },
      ], source: { kind: 'user' } },
      // A turn still in flight: one call that has no result yet.
      ...(inFlightTurn ? [{
        id: 'm6',
        role: 'assistant',
        content: [
          { type: 'text', text: 'About to read the file.' },
          { type: 'tool-call', id: 'c-pending', name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      }] : []),
    ],
  },
}

/** Every registry lookup the side thread performed, in order. */
const toolLookups = []

/** Every prompt the fake attachment store was asked to admit. */
const imageAdmissions = []
/** When set, the next admission rejects with this message. */
let imageRefusal = null
/** Serial behind the durable references the fake store mints. */
let imageSerial = 0
/** A screenshot already attached to the parent conversation. */
const CONTEXT_IMAGE = {
  attachmentId: 'sha256:ctx', mediaType: 'image/png', bytes: 4, width: 640, height: 480,
}

/**
 * The attachment store, reduced to the two calls a side request makes.
 *
 * `admitPromptContent` is where the deployment's count, byte, and format limits
 * live for a real prompt, so the side request must route images through it
 * instead of storing them itself.
 */
const fakeAttachments = {
  imageLimits: {
    maxImageBytes: 50 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 200 * 1024 * 1024,
    maxImagePixels: 64_000_000,
    maxImageDimension: 65_535,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  async admitPromptContent(parts) {
    imageAdmissions.push(parts)
    if (imageRefusal !== null) throw new Error(imageRefusal)
    return parts.map((part) => {
      if (part.type !== 'image') return { type: 'text', text: part.text }
      imageSerial += 1
      return {
        type: 'image',
        attachment: {
          attachmentId: `sha256:img${imageSerial}`,
          mediaType: part.mediaType,
          bytes: 4,
          width: 800,
          height: 600,
          ...(part.name === undefined ? {} : { name: part.name }),
        },
      }
    })
  },
  async readImage(ref) {
    return { ref, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }
  },
}

const services = new Map([
  ['agents', { get: id => (id === 'sess-1' ? fakeAgent : undefined) }],
  ['tools', {
    // Deliberately registry-wide-fragile: the Host must not depend on this.
    schemas: () => { throw new Error('bulk projection rejects unknown parameters') },
    // Reproduces the shipped behaviour: a scope-less lookup reads the global
    // view, which does not carry this session's tools.
    executable: (name, scope) => {
      toolLookups.push({ name, scope: scope === fakeAgent ? 'agent' : scope === undefined ? 'global' : 'other' })
      if (scope !== fakeAgent) return undefined
      if (name !== 'read' && name !== 'glob' && name !== 'grep' && name !== 'write') return undefined
      return { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } }
    },
    get: (name, scope) => (scope === fakeAgent
      ? { name, description: `${name} tool`, parameters: { type: 'object', properties: {} } }
      : undefined),
    execute: async (input) => {
      toolBatches.push(input)
      return {
        results: input.calls.map(call => ({
          callId: call.id,
          result: { content: [{ type: 'text', text: `contents of ${call.name}` }] },
        })),
        additionalContexts: [],
        concluded: false,
      }
    },
  }],
  ['llm', {
    stream(options) {
      llmCalls.push(options)
      llmRound += 1
      const round = llmRound
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        // A provider that fails without producing prose.
        if (llmMode === 'error') {
          yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 } }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }
          return
        }
        // A provider that never answers until the request is aborted.
        if (llmMode === 'hang') {
          await new Promise((resolve) => {
            if (options.signal?.aborted === true) {
              resolve()
              return
            }
            options.signal?.addEventListener?.('abort', () => resolve(), { once: true })
          })
          return
        }
        // A model that spends every round reading. `options.tools` is absent on
        // the closing pass, which is how the fake tells the two apart.
        if (llmMode === 'loop' || llmMode === 'loop-empty') {
          if (options.tools !== undefined) {
            yield {
              type: 'block-end', index: 0,
              block: { type: 'tool-call', id: `call-loop-${round}`, name: 'read', arguments: '{}' },
            }
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          if (llmMode === 'loop') {
            yield { type: 'text-delta', index: 0, text: 'Answered from what I read.' }
            yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'tools' && round === 1) {
          // A round that gathers files before answering.
          yield { type: 'text-delta', index: 0, text: 'Let me read it.' }
          yield {
            type: 'block-end', index: 1,
            block: { type: 'tool-call', id: 'call-read', name: 'read', arguments: '{"path":"a.ts"}' },
          }
          yield {
            type: 'block-end', index: 2,
            block: { type: 'tool-call', id: 'call-write', name: 'write', arguments: '{"path":"b.ts"}' },
          }
          yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (llmMode === 'reasoning' && round === 1) {
          // A cap spent entirely on reasoning leaves no visible prose at all.
          yield { type: 'reasoning-delta', index: 0, text: 'thinking it through' }
          yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 2048, totalTokens: 2078 } }
          yield { type: 'finish', reason: { kind: 'max-tokens' } }
          return
        }
        if (llmMode === 'markup' && round === 1) {
          // A provider that cannot serialize the call leaves the markup in prose.
          yield { type: 'text-delta', index: 0, text: 'Let me check.\n' }
          yield { type: 'text-delta', index: 0, text: '< | DSML | calls>\n< | DSML | invoke name="readfile">\n' }
          yield { type: 'text-delta', index: 0, text: '< | DSML | parameter name="path">a.ts</ | DSML | parameter>\n</ | DSML | invoke>\n</ | DSML | calls>' }
          yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (llmMode === 'markup-lookalike' && round === 1) {
          // The same fallback with separators the model made up: a box-drawing
          // bar, a full-width bar, a zero-width joiner inside the token, and the
          // whole token in full-width letters.
          yield { type: 'text-delta', index: 0, text: 'Let me check.\n' }
          yield { type: 'text-delta', index: 0, text: '\u2502 DSML \u2502 calls>\n\uFF5C DSML \uFF5C invoke name="read">\n' }
          yield { type: 'text-delta', index: 0, text: '\u2502 DS\u200BML \u2502 parameter name="path">a.ts</\u2502 DSML \u2502 parameter>' }
          yield { type: 'text-delta', index: 0, text: '\n\uFF1C \uFF5C \uFF24\uFF33\uFF2D\uFF2C \uFF5C invoke name="glob">' }
          yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'text-delta', index: 0, text: llmMode === 'tools' ? 'It ' : 'It ' }
        yield { type: 'text-delta', index: 0, text: llmMode === 'tools' ? 'holds a.ts.' : 'parses.' }
        yield {
          type: 'usage',
          usage: llmMode === 'tools'
            ? { inputTokens: 60, outputTokens: 4, totalTokens: 64, cacheReadTokens: 30 }
            : {
              inputTokens: 120, outputTokens: 8, totalTokens: 128,
              cacheReadTokens: 64, cacheWriteTokens: 0, reasoningTokens: 3,
            },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }],
  ['commands', { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } }],
  ['attachments', fakeAttachments],
  ['connection', {
    fetch: {
      register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path) } },
    },
  }],
])

const hostCtx = {
  ...makeEffectHost(),
  agents: services.get('agents'),
  llm: services.get('llm'),
  commands: services.get('commands'),
}
hostCtx.get = name => services.get(name)

const hostModule = await import(pathToFileURL(`${ROOT}/index.js`).href)
hostModule.apply(hostCtx, {
  maxExchanges: 20,
  maxContextMessages: 80,
  maxContextChars: 48000,
  maxOutputTokens: 2048,
  // Deliberately small: the request-image cap has to be observable.
  maxRequestImages: 4,
  // Deliberately short: the timeout path has to be reachable in a test.
  timeoutMs: 300,
})

check('host: inject declares its services', JSON.stringify(hostModule.inject) === '["agents","llm","commands","tools"]', hostModule.inject)
check('host: /btw command registered', commands.has('btw'), [...commands.keys()])
check('host: four Fetch routes registered',
  routes.has('/api/btw/state') && routes.has('/api/btw/ask') && routes.has('/api/btw/close') && routes.has('/api/btw/image'),
  [...routes.keys()])
check('host: ask route accepts POST only', routes.get('/api/btw/ask')?.methods?.join() === 'POST', routes.get('/api/btw/ask')?.methods)
check('host: image route accepts GET only', routes.get('/api/btw/image')?.methods?.join() === 'GET', routes.get('/api/btw/image')?.methods)

const jsonRequest = (path, body) => new Request(`https://btw.example.test${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

// Empty state before any question.
const emptyState = await (await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state?session=sess-1'))).json()
check('state: starts closed and empty', emptyState.ok === true && emptyState.open === false && emptyState.messages.length === 0, emptyState)
check('state: reports the resolved route', emptyState.route?.provider === 'deepseek' && emptyState.route?.model === 'deepseek-chat', emptyState.route)

// The /btw command queues the question without calling the model.
const command = commands.get('btw')
const commandResult = command.handler({ agent: fakeAgent, rawInput: '  What does the parser do?  ' })
const queued = await (await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state?session=sess-1'))).json()
check('command: returns a constant notice', commandResult.kind === 'success' && /panel/i.test(commandResult.text), commandResult)
check('command: keeps the question out of the log payload', command.recordInput === false, command.recordInput)
check('command: queues the trimmed question', queued.pending === 'What does the parser do?', queued.pending)
check('command: does not call the model', llmCalls.length === 0, llmCalls.length)
const bareCommand = command.handler({ agent: fakeAgent, rawInput: '   ' })
check('command: a bare /btw opens the panel instead of complaining',
  bareCommand.kind === 'success' && /type the side question/.test(bareCommand.text), bareCommand)

// The panel performs the request.
const asked = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', { sessionId: 'sess-1', question: 'What does the parser do?' }))).json()
check('ask: succeeds', asked.ok === true, asked.error)
check('ask: stores the exchange', asked.snapshot?.messages?.length === 2, asked.snapshot?.messages)
check('ask: first message is the question', asked.snapshot?.messages?.[0]?.role === 'user', asked.snapshot?.messages?.[0]?.role)
check('ask: answer text is captured', asked.snapshot?.messages?.[1]?.text === 'It parses.', asked.snapshot?.messages?.[1]?.text)
check('ask: per-answer metrics attached', asked.measurement?.inputTokens === 120 && asked.measurement?.outputTokens === 8, asked.measurement)

const call = llmCalls[0]
check('request: carrier system prompt', typeof call?.system === 'string' && call.system.includes('side question'), call?.system?.slice(0, 40))
check('request: uses the session route', call?.provider === 'deepseek' && call?.model === 'deepseek-chat', `${call?.provider}/${call?.model}`)
check('request: honours the output cap', call?.maxTokens === 2048, call?.maxTokens)
const roles = call?.messages?.map(message => message.role)
check('request: drops the parent system prompt', !roles?.includes('system'), roles)
check('request: keeps the conversation in order',
  JSON.stringify(roles) === '["user","assistant","user","user","user"]', JSON.stringify(roles))
check('request: strips the tool call block',
  !call.messages[1].content.some(block => block.type === 'tool-call'), call.messages[1].content)
check('request: renders the tool result as text',
  call.messages[2].content[0].text.startsWith('[tool result]'), call.messages[2].content[0].text)
check('request: every message carries id, source and content',
  call.messages.every(message => typeof message.id === 'string' && message.source !== undefined && Array.isArray(message.content)),
  call.messages.map(message => [message.role, typeof message.id, message.source?.kind]))
check('request: assistant carries the model source',
  call.messages[1].source?.kind === 'model' && call.messages[1].source.provider === 'deepseek', call.messages[1].source)
check('request: question is last', call.messages.at(-1).content[0].text === 'What does the parser do?', call.messages.at(-1).content[0].text)
check('request: a screenshot already in the conversation is forwarded',
  call.messages.some(message => message.content.some(block => block.type === 'image'
    && block.attachment?.attachmentId === CONTEXT_IMAGE.attachmentId)),
  call.messages.map(message => message.content.map(block => block.type).join('+')))
check('request: the system prompt says an image is attached',
  typeof call.system === 'string' && call.system.includes('attached image'), call.system)

// The side thread reports its own accounting.
const after = await (await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state?session=sess-1'))).json()
const totals = after.totals
check('metrics: counts one question', totals.asks === 1, totals.asks)
check('metrics: input tokens', totals.inputTokens === 120, totals.inputTokens)
check('metrics: output tokens', totals.outputTokens === 8, totals.outputTokens)
check('metrics: total tokens', totals.totalTokens === 128, totals.totalTokens)
check('metrics: cache read tokens', totals.cacheReadTokens === 64, totals.cacheReadTokens)
check('metrics: reasoning tokens', totals.reasoningTokens === 3, totals.reasoningTokens)
check('metrics: context size recorded', totals.contextChars > 0 && after.messages.length === 2, totals.contextChars)
check('metrics: latency recorded', typeof totals.llmMs === 'number' && totals.llmMs >= 0, totals.llmMs)
check('ask: clears the queued question', after.pending === null, after.pending)

// A follow-up replays the earlier exchange.
await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', { sessionId: 'sess-1', question: 'And the tests?' }))
const followUp = llmCalls[1]
const followRoles = followUp.messages.map(message => message.role)
check('follow-up: replays the earlier exchange after the context',
  JSON.stringify(followRoles) === '["user","assistant","user","user","user","assistant","user"]', JSON.stringify(followRoles))

// Closing forgets everything.
const closed = await (await routes.get('/api/btw/close').fetch(jsonRequest('/api/btw/close', { sessionId: 'sess-1' }))).json()
const afterClose = await (await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state?session=sess-1'))).json()
check('close: reports the thread existed', closed.ok === true && closed.cleared === true, closed)
check('close: leaves nothing behind',
  afterClose.open === false && afterClose.messages.length === 0 && afterClose.totals.asks === 0, afterClose)

// Guard rails.
const unknownSession = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', { sessionId: 'nope', question: 'hi' }))).json()
check('ask: refuses a session without a live agent', unknownSession.ok === false && unknownSession.error.code === 'session-not-live', unknownSession.error)
const noSession = await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state'))
check('state: rejects a missing session id', noSession.status === 400, noSession.status)
const noQuestion = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', { sessionId: 'sess-1', question: '   ' }))).json()
check('ask: rejects an empty question', noQuestion.ok === false && noQuestion.error.code === 'empty-question', noQuestion.error)

// ------------------------------------------------------------ read-only tools

llmMode = 'tools'
llmRound = 0
sessionAppends.length = 0
toolBatches.length = 0
const callsBefore = llmCalls.length

const withTools = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'What is in a.ts?',
}))).json()

check('tools: the side request offers only the whitelisted schemas',
  JSON.stringify((llmCalls[callsBefore]?.tools ?? []).map(tool => tool.name).sort()) === '["glob","grep","read"]',
  (llmCalls[callsBefore]?.tools ?? []).map(tool => tool.name))
check('tools: two rounds ran for one answer', llmCalls.length - callsBefore === 2, llmCalls.length - callsBefore)
check('tools: the second round carries the tool result',
  llmCalls[callsBefore + 1]?.messages?.at(-1)?.role === 'tool',
  llmCalls[callsBefore + 1]?.messages?.at(-1)?.role)
check('tools: the tool result is the executed output',
  (llmCalls[callsBefore + 1]?.messages ?? []).some(message => message.role === 'tool'
    && message.toolCallId === 'call-read' && message.content?.[0]?.text === 'contents of read'),
  (llmCalls[callsBefore + 1]?.messages ?? []).filter(m => m.role === 'tool').map(m => m.content[0]?.text))
check('tools: the assistant turn carries the requested calls',
  (llmCalls[callsBefore + 1]?.messages ?? []).some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'tool-call' && block.name === 'read')),
  (llmCalls[callsBefore + 1]?.messages ?? []).map(message => `${message.role}:${message.content.map(block => block.type).join('+')}`))
check('tools: only the whitelisted call reaches the executor',
  JSON.stringify((toolBatches[0]?.calls ?? []).map(call => call.name)) === '["read"]',
  (toolBatches[0]?.calls ?? []).map(call => call.name))
check('tools: a refused call still answers with an error result',
  (llmCalls[callsBefore + 1]?.messages ?? []).some(message => message.role === 'tool'
    && message.isError === true && /not available/.test(message.content[0]?.text ?? '')),
  (llmCalls[callsBefore + 1]?.messages ?? []).filter(m => m.role === 'tool').map(m => m.content[0]?.text))
check('tools: execution is not logged to the owning session',
  toolBatches[0]?.log === undefined && toolBatches[0]?.agent === fakeAgent,
  { log: toolBatches[0]?.log, agent: toolBatches[0]?.agent?.id })
check('tools: no session event is written while reading',
  sessionAppends.length === 0, sessionAppends.length)
check('tools: the answer is the last round that spoke',
  withTools.snapshot?.messages?.at(-1)?.text === 'It holds a.ts.', withTools.snapshot?.messages?.at(-1)?.text)
check('tools: measurement counts rounds and reads',
  withTools.measurement?.rounds === 2 && withTools.measurement?.toolCalls === 2,
  { rounds: withTools.measurement?.rounds, toolCalls: withTools.measurement?.toolCalls })
check('tools: measurement names the tools used',
  JSON.stringify(withTools.measurement?.toolNames) === '["read","write"]', withTools.measurement?.toolNames)
check('tools: usage is summed across rounds',
  withTools.measurement?.inputTokens === 160 && withTools.measurement?.outputTokens === 9,
  { input: withTools.measurement?.inputTokens, output: withTools.measurement?.outputTokens })
check('tools: a failing bulk projection does not empty the list',
  Array.isArray(withTools.snapshot?.tools?.names) && withTools.snapshot.tools.names.length === 3,
  withTools.snapshot?.tools)
check('tools: the registry is asked by name, one tool at a time',
  ['read', 'glob', 'grep'].every(name => toolLookups.some(entry => entry.name === name)),
  toolLookups.map(entry => entry.name).join(','))
check('tools: every lookup passes the agent as its scope',
  toolLookups.length > 0 && toolLookups.every(entry => entry.scope === 'agent'),
  toolLookups.map(entry => `${entry.name}:${entry.scope}`).join(' '))

// A model that spends every tool round reading must still answer the question.
llmMode = 'loop'
llmRound = 0
const loopBefore = llmCalls.length
const looped = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'What are the current changes?',
}))).json()
const loopCalls = llmCalls.slice(loopBefore)
const closingCall = loopCalls.at(-1)
check('tools: the tool rounds all ran before the closing pass',
  loopCalls.length === 6, loopCalls.length)
check('tools: a question that spends its whole budget still gets an answer',
  looped.snapshot?.messages?.at(-1)?.text === 'Answered from what I read.',
  looped.snapshot?.messages?.at(-1)?.text)
check('tools: the closing pass is sent without tools',
  closingCall?.tools === undefined && (loopCalls.at(-2)?.tools?.length ?? 0) === 3,
  { closing: closingCall?.tools, lastRound: loopCalls.at(-2)?.tools?.length })
check('tools: the closing prompt says the budget is spent',
  /budget .* is spent/.test(closingCall?.system ?? ''), closingCall?.system?.slice(-140))
check('tools: the closing pass ends with a user turn that says tools are gone',
  closingCall?.messages?.at(-1)?.role === 'user'
  && /No tools are available/.test(closingCall?.messages?.at(-1)?.content?.[0]?.text ?? ''),
  closingCall?.messages?.at(-1))
check('tools: only the paid rounds executed calls',
  looped.measurement?.toolCalls === 4 && looped.measurement?.droppedCalls === 1,
  { executed: looped.measurement?.toolCalls, dropped: looped.measurement?.droppedCalls })
check('tools: the exhausted budget is recorded',
  looped.measurement?.toolBudgetExhausted === true, looped.measurement?.toolBudgetExhausted)
check('tools: the closing pass counts as a round',
  looped.measurement?.rounds === 6, looped.measurement?.rounds)

// Even a closing pass can come back empty; that must be reported, not hidden.
llmMode = 'loop-empty'
llmRound = 0
const loopEmpty = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'And now?',
}))).json()
const loopEmptyAnswer = loopEmpty.snapshot?.messages?.at(-1)
check('tools: an empty closing pass is recorded with its reason',
  loopEmpty.ok === true && loopEmptyAnswer?.text === ''
  && loopEmptyAnswer?.metrics?.toolBudgetExhausted === true,
  { text: loopEmptyAnswer?.text, metrics: loopEmptyAnswer?.metrics?.toolBudgetExhausted })
llmMode = 'plain'
llmRound = 0

// Markup a provider left in the prose must never reach the panel.
llmMode = 'markup'
llmRound = 0
const markupAsk = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'Where is a.ts?',
}))).json()
const markupText = markupAsk.snapshot?.messages?.at(-1)?.text ?? ''
check('markup: tool-call markup never reaches the answer',
  !markupText.includes('DSML') && !markupText.includes('</ |'), markupText)
check('markup: the prose around it survives', markupText === 'Let me check.', markupText)
check('markup: the measurement records the fallback',
  markupAsk.measurement?.toolMarkup === true, markupAsk.measurement?.toolMarkup)
check('markup: no tool round ran', markupAsk.measurement?.rounds === 1, markupAsk.measurement?.rounds)

// The same fallback with separators the model invented must be recognized too:
// matching only the ASCII pipe once let a whole call render as the answer.
llmMode = 'markup-lookalike'
llmRound = 0
const lookalikeAsk = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'Where is a.ts?',
}))).json()
const lookalikeText = lookalikeAsk.snapshot?.messages?.at(-1)?.text ?? ''
check('markup: a made-up separator is still recognized',
  lookalikeText === 'Let me check.' && lookalikeAsk.measurement?.toolMarkup === true,
  { text: lookalikeText, stripped: lookalikeAsk.measurement?.toolMarkup })
check('markup: no box-drawing or full-width bar survives',
  !/[\u2502\uFF5C]/.test(lookalikeText) && !/DSML/i.test(lookalikeText), lookalikeText)

// An ask that produced no prose must still be recorded, with its reason.
llmMode = 'reasoning'
llmRound = 0
const emptyAsk = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'What is in b.ts?',
}))).json()
check('empty: an ask with no prose is still recorded',
  emptyAsk.ok === true
    && emptyAsk.snapshot?.messages?.at(-1)?.role === 'assistant'
    && emptyAsk.snapshot.messages.at(-1).text === '',
  { ok: emptyAsk.ok, last: emptyAsk.snapshot?.messages?.at(-1) })
check('empty: the measurement names the truncation',
  emptyAsk.measurement?.finish === 'max-tokens' && emptyAsk.measurement?.outputChars === 0,
  { finish: emptyAsk.measurement?.finish, chars: emptyAsk.measurement?.outputChars })
check('empty: the question is kept for the next turn',
  emptyAsk.snapshot?.messages?.at(-2)?.text === 'What is in b.ts?',
  emptyAsk.snapshot?.messages?.at(-2)?.text)
llmMode = 'plain'

// ------------------------------------------------------------------- images

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
const askedWithImage = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1',
  question: 'What is wrong in this screenshot?',
  images: [{ mediaType: 'image/png', data: PNG_BASE64, name: 'clip.png' }],
}))).json()
check('images: a question may carry one image', askedWithImage.ok === true, askedWithImage.error)
const imageCall = llmCalls.at(-1)
const imageQuestion = imageCall?.messages?.at(-1)
const askedRef = imageQuestion?.content?.find(block => block.type === 'image')?.attachment
check('images: the question carries the durable reference',
  askedRef !== undefined && typeof askedRef.attachmentId === 'string' && askedRef.mediaType === 'image/png',
  imageQuestion?.content)
check('images: admission went through the attachment service',
  imageAdmissions.length === 1 && imageAdmissions[0].length === 2
  && imageAdmissions[0][1].name === 'clip.png',
  imageAdmissions.map(parts => parts.map(part => part.type).join('+')))
check('images: the panel gets the reference back for the question row',
  (askedWithImage.snapshot?.messages ?? []).some(message => message.attachments?.[0]?.attachmentId === askedRef?.attachmentId),
  (askedWithImage.snapshot?.messages ?? []).map(message => message.attachments))
check('images: measurement separates asked and request images',
  askedWithImage.measurement?.askedImages === 1 && askedWithImage.measurement?.requestImages === 2
  && askedWithImage.measurement?.contextImages === 1,
  {
    asked: askedWithImage.measurement?.askedImages,
    request: askedWithImage.measurement?.requestImages,
    context: askedWithImage.measurement?.contextImages,
  })

// The panel draws the picture it asked about through this route.
const imageRoute = routes.get('/api/btw/image')
const served = await imageRoute.fetch(jsonRequest(
  `/api/btw/image?session=sess-1&attachment=${encodeURIComponent(askedRef?.attachmentId ?? '')}`,
))
const servedBytes = new Uint8Array(await served.arrayBuffer())
check('images: the route serves the admitted image', served.status === 200
  && served.headers.get('content-type') === 'image/png', served.status)
check('images: the served bytes are the stored object',
  servedBytes.length === 4 && servedBytes[0] === 0x89, [...servedBytes])
const foreign = await imageRoute.fetch(jsonRequest('/api/btw/image?session=sess-1&attachment=sha256%3Aelsewhere'))
check('images: a reference this thread never admitted is a 404', foreign.status === 404, foreign.status)
const noAttachment = await imageRoute.fetch(jsonRequest('/api/btw/image?session=sess-1'))
check('images: a missing attachment id is a 400', noAttachment.status === 400, noAttachment.status)

// The request keeps only the newest occurrences.
const capped = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1',
  question: 'Which of these six shots matters?',
  images: Array.from({ length: 6 }, (_, index) => ({
    mediaType: 'image/jpeg', data: PNG_BASE64, name: `shot-${index}.jpg`,
  })),
}))).json()
const cappedCall = llmCalls.at(-1)
const notes = (cappedCall?.messages ?? []).flatMap(message => message.content)
  .filter(block => block.type === 'text' && /omitted to fit the request limit/.test(block.text))
check('images: the request keeps only the newest occurrences',
  capped.measurement?.requestImages === 4 && capped.measurement?.askedImages === 6,
  { request: capped.measurement?.requestImages, asked: capped.measurement?.askedImages })
check('images: dropped occurrences are replaced by a note', notes.length === 4, notes.length)
check('images: a capped request still answers', capped.ok === true, capped.error)

// Refusals.
const tooMany = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1',
  question: 'too many',
  images: Array.from({ length: 7 }, () => ({ mediaType: 'image/png', data: PNG_BASE64 })),
}))).json()
check('images: more images than one question allows are refused',
  tooMany.ok === false && tooMany.error?.code === 'too-many-images', tooMany.error)
const wrongType = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1',
  question: 'a pdf',
  images: [{ mediaType: 'application/pdf', data: PNG_BASE64 }],
}))).json()
check('images: a non-raster payload is refused',
  wrongType.ok === false && wrongType.error?.code === 'bad-image', wrongType.error)
imageRefusal = 'Image exceeds the configured byte limit.'
const storeRefusal = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1',
  question: 'a huge one',
  images: [{ mediaType: 'image/png', data: PNG_BASE64 }],
}))).json()
imageRefusal = null
check('images: a store refusal becomes a business failure',
  storeRefusal.ok === false && storeRefusal.error?.code === 'image-refused'
  && /byte limit/.test(storeRefusal.error.message), storeRefusal.error)
const afterRefusal = await (await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state?session=sess-1'))).json()
check('images: a refused question does not leave the panel busy',
  afterRefusal.busy === false && afterRefusal.open === true, { busy: afterRefusal.busy, open: afterRefusal.open })
check('images: the panel is told image input is available',
  afterRefusal.images?.enabled === true && afterRefusal.images?.max === 6, afterRefusal.images)

// ------------------------------------------------ settled context and failures

// A turn still in flight is not a conversation yet: only settled messages travel.
inFlightTurn = true
llmMode = 'plain'
llmRound = 0
const settledBefore = llmCalls.length
const settledAsk = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'Where are we?',
}))).json()
const settledCall = llmCalls[settledBefore]
inFlightTurn = false
check('settled: an unfinished turn ends the snapshot',
  !(settledCall?.messages ?? []).some(message => message.content
    .some(block => block.type === 'text' && block.text === 'About to read the file.')),
  (settledCall?.messages ?? []).map(message => message.role))
check('settled: an unresolved call never enters the request',
  !(settledCall?.messages ?? []).some(message => message.content.some(block => block.type === 'tool-call')),
  (settledCall?.messages ?? []).map(message => message.content.map(block => block.type).join('+')))
check('settled: the settled part still reaches the model',
  settledAsk.ok === true && (settledCall?.messages ?? [])
    .some(message => message.content.some(block => block.text === 'Now add tests.')),
  settledCall?.messages?.length)

// A provider failure is a row the panel can act on, not a dead end.
llmMode = 'error'
llmRound = 0
const failedAsk = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'Summarize the plan.',
}))).json()
const failedRow = failedAsk.snapshot?.messages?.at(-1)
check('failure: a provider error is recorded as a retryable row',
  failedAsk.ok === true && failedRow?.failure?.reason === 'error' && failedRow?.text === '',
  { ok: failedAsk.ok, failure: failedRow?.failure })
check('failure: the row keeps the usage that was billed',
  failedAsk.measurement?.inputTokens === 7 && failedAsk.snapshot?.totals?.failed >= 1,
  { input: failedAsk.measurement?.inputTokens, failed: failedAsk.snapshot?.totals?.failed })
const usersAtFailure = (failedAsk.snapshot?.messages ?? []).filter(message => message.role === 'user').length

llmMode = 'plain'
llmRound = 0
const retried = await (await routes.get('/api/btw/retry').fetch(jsonRequest('/api/btw/retry', {
  sessionId: 'sess-1', key: failedRow?.key,
}))).json()
const retriedRow = retried.snapshot?.messages?.at(-1)
check('retry: the same question is answered again',
  retried.ok === true && retriedRow?.text === 'It parses.' && retriedRow?.failure === null,
  { ok: retried.ok, text: retriedRow?.text, failure: retriedRow?.failure })
check('retry: no second question row is added',
  (retried.snapshot?.messages ?? []).filter(message => message.role === 'user').length === usersAtFailure,
  (retried.snapshot?.messages ?? []).filter(message => message.role === 'user').length)
check('retry: the failed row is replaced in place',
  (retried.snapshot?.messages ?? []).length === (failedAsk.snapshot?.messages ?? []).length,
  [(failedAsk.snapshot?.messages ?? []).length, (retried.snapshot?.messages ?? []).length])
const answeredKey = retriedRow?.key
const notRetryable = await (await routes.get('/api/btw/retry').fetch(jsonRequest('/api/btw/retry', {
  sessionId: 'sess-1', key: answeredKey,
}))).json()
check('retry: a successful row is not retryable',
  notRetryable.ok === false && notRetryable.error?.code === 'answered', notRetryable.error)

// A provider that never answers fails on the timer instead of spinning forever.
llmMode = 'hang'
const timedOut = await (await routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'Are you there?',
}))).json()
const timeoutRow = timedOut.snapshot?.messages?.at(-1)
check('timeout: a hung request fails instead of spinning forever',
  timedOut.ok === true && timeoutRow?.failure?.reason === 'timeout', timeoutRow?.failure)
check('timeout: the row says how long it waited',
  /within \d+s/.test(timeoutRow?.failure?.message ?? ''), timeoutRow?.failure?.message)
check('timeout: the thread is free again',
  timedOut.snapshot?.busy === false, timedOut.snapshot?.busy)

// Closing the panel mid-answer discards the result instead of resurrecting it.
llmMode = 'hang'
const pendingAnswer = routes.get('/api/btw/ask').fetch(jsonRequest('/api/btw/ask', {
  sessionId: 'sess-1', question: 'still there?',
}))
await new Promise((resolve) => setTimeout(resolve, 20))
await routes.get('/api/btw/close').fetch(jsonRequest('/api/btw/close', { sessionId: 'sess-1' }))
const closedMidAnswer = await (await pendingAnswer).json()
check('close: an in-flight answer is discarded',
  closedMidAnswer.ok === true && closedMidAnswer.stale === true, closedMidAnswer)
const afterMidClose = await (await routes.get('/api/btw/state').fetch(jsonRequest('/api/btw/state?session=sess-1'))).json()
check('close: the discarded answer does not come back',
  afterMidClose.open === false && afterMidClose.messages.length === 0, afterMidClose)
llmMode = 'plain'
llmRound = 0

// -------------------------------------------------------------- Client half

let moduleSpec
globalThis.window = { __ModuleLoader__: { load(spec) { moduleSpec = spec } } }

const clientRegistrations = { locale: [], tabTypes: [], closeHandlers: [], slots: [], openCalls: [], activeTab: undefined }
const clientDisposers = []
function fakeCtx() {
  const scope = {
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') clientDisposers.push(disposer)
      return disposer
    },
    get(name) {
      return clientServices.get(name)
    },
  }
  return scope
}
const localeDicts = new Map()
const clientServices = new Map()
clientServices.set('locale', {
  register(namespace, locale, dict) {
    clientRegistrations.locale.push([namespace, locale])
    localeDicts.set(`${namespace}:${locale}`, dict)
    return () => {}
  },
  bind(namespace) {
    return key => {
      const dict = localeDicts.get(`${namespace}:zh`) ?? {}
      return dict[key] ?? key
    }
  },
  getLocale: () => ({ id: 'zh-CN' }),
  subscribe: () => () => {},
})
clientServices.set('sidebarRightTabs', {
  register(definition) { clientRegistrations.tabTypes.push(definition); return () => {} },
})
clientServices.set('sidebarRight', {
  registerCloseHandler(kind, handler) { clientRegistrations.closeHandlers.push([kind, handler]); return () => {} },
  openTab(kind) { clientRegistrations.opened = kind; clientRegistrations.openCalls.push(kind) },
  active() { return clientRegistrations.activeTab },
})
clientServices.set('slots', {
  inject(owner, callback) { return callback() },
  register(options, component) {
    clientRegistrations.slots.push({ options, component })
    return () => {}
  },
})
const clientCtx = {
  ...fakeCtx(),
  slots: clientServices.get('slots'),
  locale: clientServices.get('locale'),
  sidebarRight: clientServices.get('sidebarRight'),
  sidebarRightTabs: clientServices.get('sidebarRightTabs'),
}

await import(pathToFileURL(`${ROOT}/client.js`).href)
check('client: registers through the module loader', moduleSpec?.id === 'dsh-btw-session', moduleSpec?.id)

/** When set, the next `useState` starts from this value (a pre-loaded panel). */
let seedNext
/** Component state captured by the stub React, so a click can be observed. */
const stateSlots = []
/** When set, the next `useState` starts from `true` (renders an opened disclosure). */
let openNext = false

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(2) }
  },
  useCallback: fn => fn,
  // The stub runs effects inline so a mount-time decision can be observed.
  useEffect: (fn) => { fn() },
  useMemo: fn => fn(),
  useRef: value => ({ current: value }),
  useState(initial) {
    if (seedNext !== undefined) {
      const seeded = { value: seedNext }
      seedNext = undefined
      stateSlots.push(seeded)
      return [seeded.value, next => { seeded.value = typeof next === 'function' ? next(seeded.value) : next }]
    }
    if (openNext) {
      openNext = false
      const slot = { value: true }
      stateSlots.push(slot)
      return [true, () => {}]
    }
    const slot = { value: typeof initial === 'function' ? initial() : initial }
    stateSlots.push(slot)
    return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
  },
}
const clientModule = moduleSpec.factory(name => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
})
check('client: declares its services',
  JSON.stringify(clientModule.inject) === '["slots","locale","sidebarRight","sidebarRightTabs"]', clientModule.inject)

clientModule.apply(clientCtx)

check('client: registers the English dictionary', clientRegistrations.locale.some(([ns, locale]) => ns === 'btwSession' && locale === 'en'), clientRegistrations.locale)
check('client: registers the Chinese dictionary', clientRegistrations.locale.some(([ns, locale]) => ns === 'btwSession' && locale === 'zh'), clientRegistrations.locale)

const definition = clientRegistrations.tabTypes[0]
check('client: registers one tab type', clientRegistrations.tabTypes.length === 1, clientRegistrations.tabTypes.length)
check('client: tab kind is btw', definition?.kind === 'btw', definition?.kind)
check('client: tab id matches the body key',
  definition?.id === 'dsh-btw-session/tab', definition?.id)
check('client: tab chip title is localized', definition?.title('') === '临时会话', definition?.title(''))
const guide = definition?.guide?.[0]
check('client: contributes a guide entry',
  guide !== undefined && guide.id === 'btw' && typeof guide.order === 'number', guide)
check('client: guide entry copy is localized',
  guide?.title() === '临时会话（/btw）' && /不写回/.test(guide.description()), [guide?.title(), guide?.description()])

const body = clientRegistrations.slots.find(entry => entry.options.name === 'sidebar.right.pane.tab')
check('client: registers the panel body under the tab id',
  body?.options.key === 'dsh-btw-session/tab' && typeof body.component === 'function', body?.options.key)
check('client: panel body asks for the btwSession locale',
  body?.options.locale === 'btwSession', body?.options.locale)

const commandRow = clientRegistrations.slots.find(entry => entry.options.name === 'conversation.chat.commandview')
check('client: renders the /btw command row',
  commandRow?.options.key === 'btw' && typeof commandRow.component === 'function', commandRow?.options.key)

const closeHandler = clientRegistrations.closeHandlers.find(([kind]) => kind === 'btw')
check('client: registers a close handler for the tab kind',
  closeHandler !== undefined && typeof closeHandler[1] === 'function', closeHandler?.[0])

// -------------------------------------------------- command row and the layout

const { BtwCommandRow } = clientModule.internal
/** The row's own copy; this block runs before the shared translator exists. */
const rowT = key => ({ commandOpened: 'sent to the panel', openPanel: 'Open panel' })[key] ?? key
const commandNode = overrides => ({
  kind: 'command', seq: 1, time: Date.now(), commandId: 'cmd-fresh',
  name: 'btw', args: 'q', outcome: { kind: 'success', text: 'Btw panel opened' }, ...overrides,
})

const openCount = () => clientRegistrations.openCalls.length
const beforeOpens = openCount()
walk(BtwCommandRow({ node: commandNode(), t: rowT }))
check('command row: a command that just ran opens the panel once',
  openCount() - beforeOpens === 1, openCount() - beforeOpens)

// The chat unmounts and remounts rows on every session visit.
walk(BtwCommandRow({ node: commandNode(), t: rowT }))
walk(BtwCommandRow({ node: commandNode(), t: rowT }))
check('command row: remounting the same row does not reopen it',
  openCount() - beforeOpens === 1, openCount() - beforeOpens)

// A row from an earlier visit is a record; it must not move the shell layout.
const beforeOld = openCount()
walk(BtwCommandRow({
  node: commandNode({ commandId: 'cmd-old', seq: 9, time: Date.now() - 3_600_000 }),
  t: rowT,
}))
check('command row: a historical row leaves the layout alone',
  openCount() === beforeOld, openCount() - beforeOld)
check('command row: a historical row still offers a way in',
  collectByClass(BtwCommandRow({
    node: commandNode({ commandId: 'cmd-old2', seq: 10, time: Date.now() - 3_600_000 }),
    t: rowT,
  }), 'btw-command-open').length === 1,
  collectByClass(BtwCommandRow({
    node: commandNode({ commandId: 'cmd-old3', seq: 11, time: Date.now() - 3_600_000 }),
    t: rowT,
  }), 'btw-command-open').length)

// Pressing that control is the user's own decision, so it may open.
const manual = collectByClass(BtwCommandRow({
  node: commandNode({ commandId: 'cmd-manual', seq: 12, time: Date.now() - 3_600_000 }),
  t: rowT,
}), 'btw-command-open')[0]
const beforeManual = openCount()
manual.props.onClick()
check('command row: the manual control opens the panel', openCount() - beforeManual === 1, openCount() - beforeManual)

// Already the active tab: revealing it again would re-assert the column.
clientRegistrations.activeTab = { kind: 'btw' }
const beforeActive = openCount()
walk(BtwCommandRow({ node: commandNode({ commandId: 'cmd-active', seq: 13 }), t: rowT }))
check('command row: an already visible panel is not re-opened', openCount() === beforeActive, openCount() - beforeActive)
clientRegistrations.activeTab = undefined

// ------------------------------------------------------------------ markdown

/** Flatten one built React tree into tags and text. */
function walk(node, tags = [], texts = []) {
  if (node === null || node === undefined || node === false || node === true) return { tags, texts }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, tags, texts)
    return { tags, texts }
  }
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return { tags, texts } }
  if (typeof node.type === 'function') {
    walk(node.type({ ...node.props, children: node.children }), tags, texts)
    return { tags, texts }
  }
  tags.push(node.type)
  if (node.type === 'br') texts.push('\n')
  for (const child of node.children ?? []) walk(child, tags, texts)
  if (node.type === 'input' && node.props.checked) texts.push('[x]')
  return { tags, texts }
}

const {
  parseBlocks, renderMarkdown, highlight, usageSummary, UsageStrip, Exchange,
  imageUrl, imageParts, pickImages, limitsLine, limitsHint, readImageFile,
  routeLabel, routeTitle,
} = clientModule.internal
const translate = (key, params) => {
  const dict = { copy: 'Copy', copied: 'Copied', copyAnswer: 'Copy the answer', openPanel: 'Open panel', reads: '{count} reads', noContext: 'no context sent', emptyMarkup: 'model wrote its tool call as text', emptyTruncated: 'cut off at the output limit', emptyError: 'failed before any text', emptyAborted: 'cancelled', emptyNoText: 'returned no text' }
  const raw = dict[key] ?? {
    askCount: '{count} asks',
    cacheHit: 'cache hit {percent}%',
    tokPerSecond: '{tps} tok/s',
    tok: '{value} tok',
    chars: 'chars',
    asks: 'Questions',
    total: 'Total tokens',
    input: 'Uncached input',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    output: 'Output',
    reasoning: 'Reasoning',
    context: 'Context sent',
    latency: 'Total time',
    firstToken: 'First token',
    average: 'Average per answer',
    expand: 'Show usage detail',
    collapse: 'Hide usage detail',
    toolList: 'Tools',
    toolOff: 'off',
    toolOffDisabled: 'off (empty whitelist)',
    toolOffNoRegistry: 'off (no tool service)',
    toolOffNotAdmitted: 'off (not granted to this session)',
    toolOffUncloneable: 'off (schema not serializable)',
    toolOffIdle: 'not used yet',
    toolMarkupNote: 'tool call came back as text',
    emptyToolBudget: 'tool rounds ran out after {reads} looks',
    budgetWarn: 'read budget hit',
    budgetWarnTitle: 'the tool rounds ran out before this answer',
    retry: 'Retry',
    failureTimeout: 'did not finish in time',
    failureInterrupted: 'cancelled',
    failureError: 'the model call failed',
    route: 'Model',
    imageCount: 'Images',
    limitsLine: 'replay ≤{replay} turns · context ≤{context} msgs',
    limitsHint: 'built from the last {context} messages (older ones drop off past {chars} characters) plus the last {replay} turns',
  }[key] ?? key
  return typeof raw === 'string'
    ? raw.replace(/\{(\w+)\}/g, (whole, name) => (params?.[name] === undefined ? whole : String(params[name])))
    : raw
}

const source = [
  '# 结论',
  '',
  '解析器**已经可用**，见 `parser.ts` 与 [文档](https://example.com/doc)。',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '- 第一项',
  '- 第二项',
  '  1. 嵌套一',
  '  2. 嵌套二',
  '- [x] 已完成',
  '',
  '| 指标 | 值 |',
  '| --- | ---: |',
  '| 输入 | 15k |',
  '',
  '> 引用一行',
  '',
  '---',
].join('\n')

const blocks = parseBlocks(source)
const kinds = blocks.map(block => block.kind)
check('markdown: block sequence',
  JSON.stringify(kinds) === '["heading","paragraph","code","list","table","quote","hr"]', kinds)
check('markdown: heading level', blocks[0]?.level === 1 && blocks[0]?.text === '结论', blocks[0])
check('markdown: fenced code captures language and body',
  blocks[2]?.lang === 'js' && blocks[2]?.code === 'const a = 1', blocks[2])
check('markdown: three list items, one nested ordered list',
  blocks[3]?.items?.length === 3, blocks[3]?.items?.length)
check('markdown: nested list parses as its own block',
  blocks[3]?.items?.[1]?.blocks?.some(block => block.kind === 'list' && block.ordered === true),
  JSON.stringify(blocks[3]?.items?.[1]?.blocks?.map(block => block.kind)))
check('markdown: task item keeps its checkbox state',
  blocks[3]?.items?.[2]?.blocks?.[0]?.text?.startsWith('[x] '),
  blocks[3]?.items?.[2]?.blocks?.[0]?.text)
check('markdown: table header and alignment',
  JSON.stringify(blocks[4]?.header) === '["指标","值"]'
    && JSON.stringify(blocks[4]?.alignments) === '[null,"right"]', blocks[4])
check('markdown: table body rows',
  JSON.stringify(blocks[4]?.rows) === '[["输入","15k"]]', blocks[4]?.rows)
check('markdown: quote keeps its inner blocks',
  blocks[5]?.blocks?.[0]?.kind === 'paragraph' && blocks[5]?.blocks?.[0]?.text === '引用一行', blocks[5])

const tree = walk(renderMarkdown(source, translate))
const joined = tree.texts.join('')
check('markdown: emits headings, code, lists, tables and quotes',
  ['h1', 'p', 'pre', 'ul', 'ol', 'table', 'blockquote', 'hr', 'code', 'strong', 'a', 'input']
    .every(tag => tree.tags.includes(tag)),
  [...new Set(tree.tags)].join(','))
check('markdown: no raw syntax survives',
  !joined.includes('**') && !joined.includes('```') && !joined.includes('|---'), joined.slice(0, 120))
check('markdown: link destination is carried',
  renderWalkFind(renderMarkdown('[文档](https://example.com/doc)', translate), 'a')?.props?.href === 'https://example.com/doc',
  renderWalkFind(renderMarkdown('[文档](https://example.com/doc)', translate), 'a')?.props)
check('markdown: a non-web link destination stays text',
  renderWalkFind(renderMarkdown('[文档](file:///tmp/secret.txt)', translate), 'a') === undefined
    && walk(renderMarkdown('[文档](file:///tmp/secret.txt)', translate)).texts.join('') === '文档',
  renderWalkFind(renderMarkdown('[文档](file:///tmp/secret.txt)', translate), 'a')?.props)
check('markdown: a script link destination stays text',
  renderWalkFind(renderMarkdown('[x](javascript:alert(1))', translate), 'a') === undefined,
  renderWalkFind(renderMarkdown('[x](javascript:alert(1))', translate), 'a')?.props)
check('markdown: inline code keeps its text',
  renderWalkFind(renderMarkdown('见 `parser.ts`', translate), 'code') !== undefined,
  renderWalkFind(renderMarkdown('见 `parser.ts`', translate), 'code')?.children)
check('markdown: code block offers a copy control',
  renderWalkFind(renderMarkdown('```ts\nlet a = 1\n```', translate), 'button') !== undefined,
  renderWalkFind(renderMarkdown('```ts\nlet a = 1\n```', translate), 'button')?.children)
check('markdown: html in an answer stays text',
  walk(renderMarkdown('<img src=x onerror=alert(1)>', translate)).texts.join('') === '<img src=x onerror=alert(1)>',
  walk(renderMarkdown('<img src=x onerror=alert(1)>', translate)).texts)

const jsRuns = highlight('const a = "x" // note\nlet b = 42', 'js')
check('highlight: colours a known language',
  jsRuns.some(run => run.kind === 'kw') && jsRuns.some(run => run.kind === 'str')
    && jsRuns.some(run => run.kind === 'num') && jsRuns.some(run => run.kind === 'com'),
  jsRuns.map(run => `${run.kind ?? '-'}:${run.text}`).join(' '))
check('highlight: never loses source text',
  jsRuns.map(run => run.text).join('') === 'const a = "x" // note\nlet b = 42',
  jsRuns.map(run => run.text).join(''))
check('highlight: leaves an unknown language alone',
  highlight('SELECT * FROM t', 'diff').length === 1, highlight('SELECT * FROM t', 'diff').length)
check('highlight: python comments use the hash family',
  highlight('# note\nx = 1', 'python').some(run => run.kind === 'com'),
  highlight('# note\nx = 1', 'python').map(run => run.kind))
check('markdown: code block renders coloured spans',
  walk(renderMarkdown('```js\nconst a = 1\n```', translate)).tags.includes('span'),
  [...new Set(walk(renderMarkdown('```js\nconst a = 1\n```', translate)).tags)].join(','))

// ------------------------------------------------------------- usage strip

const stripTotals = {
  asks: 2,
  inputTokens: 17000,
  outputTokens: 3400,
  cacheReadTokens: 16000,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 36400,
  contextChars: 95000,
  llmMs: 42800,
  ttftMs: 36000,
}
const summary = usageSummary(stripTotals)
check('usage: prompt-side buckets are summed', summary.billedInput === 33000, summary.billedInput)
check('usage: total is billed input plus output', summary.total === 36400, summary.total)
check('usage: cache-hit share of prompt-side input',
  Math.abs(summary.percent - 48.5) < 0.05, summary.percent)
check('usage: a partial hit never rounds up to 100',
  usageSummary({ asks: 1, inputTokens: 1, cacheReadTokens: 999999, cacheWriteTokens: 0, outputTokens: 1 }).percent === 99.9,
  usageSummary({ asks: 1, inputTokens: 1, cacheReadTokens: 999999, cacheWriteTokens: 0, outputTokens: 1 }).percent)
check('usage: a real full hit stays 100',
  usageSummary({ asks: 1, inputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 1 }).percent === 100,
  usageSummary({ asks: 1, inputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 1 }).percent)
check('usage: decode speed excludes first-token wait',
  Math.abs(summary.tps - 3400 / 6.8) < 0.5, summary.tps)
check('usage: no billed input means no cache-hit reading',
  usageSummary({ asks: 1 }).percent === null, usageSummary({ asks: 1 }).percent)

const stripTree = UsageStrip({ totals: stripTotals, t: translate })
/** That render's disclosure slot, captured as it was created. */
const stripState = stateSlots[stateSlots.length - 1]
const strip = walk(stripTree)
const stripText = strip.texts.join('')
check('usage strip: collapsed by default',
  strip.tags.includes('button') && !strip.tags.includes('dl'), [...new Set(strip.tags)].join(','))
check('usage strip: button reports its expanded state',
  collectByClass(stripTree, 'btw-pills')[0]?.props['aria-expanded'] === false,
  collectByClass(stripTree, 'btw-pills')[0]?.props['aria-expanded'])
check('usage strip: two reading pills and a chevron',
  collectByClass(stripTree, 'btw-pill').length === 2 && collectByClass(stripTree, 'btw-chevron').length === 1,
  `${collectByClass(stripTree, 'btw-pill').length}/${collectByClass(stripTree, 'btw-chevron').length}`)
check('usage strip: activity reading carries count and speed',
  stripText.includes('2 asks') && stripText.includes('500 tok/s'), stripText)
check('usage strip: usage reading carries tokens and cache hit',
  stripText.includes('36k tok') && stripText.includes('cache hit 48.5%'), stripText)
check('usage strip: no reading without questions',
  UsageStrip({ totals: { asks: 0 }, t: translate }) === null, UsageStrip({ totals: { asks: 0 }, t: translate }))

// Pressing the row flips the disclosure, and the open state renders the breakdown.
collectByClass(stripTree, 'btw-pills')[0].props.onClick()
check('usage strip: pressing the row opens it', stripState?.value === true, stripState?.value)
openNext = true
const expandedTree = UsageStrip({ totals: stripTotals, t: translate })
const expanded = walk(expandedTree)
check('usage strip: opened state renders the breakdown',
  expanded.tags.includes('dl') && expanded.tags.includes('dt') && expanded.tags.includes('dd'),
  [...new Set(expanded.tags)].join(','))
check('usage strip: breakdown keeps the bucket names of the main strip',
  expanded.texts.includes('Uncached input') && expanded.texts.includes('Cache read')
    && expanded.texts.includes('Output') && expanded.texts.includes('Average per answer'),
  expanded.texts.join('|').slice(0, 160))
check('usage strip: empty buckets are dropped',
  !expanded.texts.includes('Cache write') && !expanded.texts.includes('Reasoning'),
  expanded.texts.filter(text => text === 'Cache write' || text === 'Reasoning'))
check('usage strip: expanded button reports open',
  collectByClass(expandedTree, 'btw-pills')[0]?.props['aria-expanded'] === true,
  collectByClass(expandedTree, 'btw-pills')[0]?.props['aria-expanded'])
check('usage strip: chevron is marked open', collectByClass(expandedTree, 'btw-chevron')[0]?.props['data-open'] === 'true',
  collectByClass(expandedTree, 'btw-chevron')[0]?.props['data-open'])

// ------------------------------------------------------------- answer row

const answerTree = Exchange({
  message: {
    key: 'a1', role: 'assistant', text: 'The **parser** lives in `a.ts`.',
    metrics: { inputTokens: 10, outputTokens: 3, llmMs: 900, rounds: 2, toolCalls: 1 },
  },
  t: translate,
})
const answerRow = walk(answerTree)
check('answer row: renders markdown, not source',
  answerRow.tags.includes('strong') && !answerRow.texts.join('').includes('**'),
  answerRow.texts.join('').slice(0, 60))
check('answer row: a copy control mirrors the reference implementation',
  collectByClass(answerTree, 'btw-copy').length === 1,
  collectByClass(answerTree, 'btw-copy').length)
check('answer row: footer reports rounds and reads',
  answerRow.texts.join('|').includes('2×') && answerRow.texts.join('|').includes('1 reads'),
  answerRow.texts.join('|'))
const questionTree = Exchange({ message: { key: 'q1', role: 'user', text: 'what is in a.ts?' }, t: translate })
check('answer row: a question gets no copy control',
  collectByClass(questionTree, 'btw-copy').length === 0 && walk(questionTree).texts.join('') === 'what is in a.ts?',
  walk(questionTree).texts.join(''))

const markupTree = Exchange({
  message: { key: 'a2', role: 'assistant', text: 'only context', metrics: { toolMarkup: true, inputTokens: 1, outputTokens: 1, llmMs: 10 } },
  t: translate,
})
check('answer row: a markup fallback is called out',
  collectByClass(markupTree, 'btw-warn').length === 1
    && walk(markupTree).texts.join('|').includes('tool call came back as text'),
  collectByClass(markupTree, 'btw-warn').length)

// An empty answer must explain itself rather than leave a blank row.
const blankFor = metrics => walk(Exchange({
  message: { key: 'a3', role: 'assistant', text: '', metrics },
  t: translate,
})).texts.join('|')
check('answer row: a truncated empty answer says so',
  blankFor({ finish: 'max-tokens', outputChars: 0 }).includes('cut off at the output limit'),
  blankFor({ finish: 'max-tokens', outputChars: 0 }))
check('answer row: a markup-only answer says so',
  blankFor({ toolMarkup: true, finish: 'stop' }).includes('tool call as text'),
  blankFor({ toolMarkup: true, finish: 'stop' }))
check('answer row: a failed call says so',
  blankFor({ finish: 'error' }).includes('failed before any text'),
  blankFor({ finish: 'error' }))
check('answer row: an unexplained empty answer still reports',
  blankFor({ finish: 'stop' }).includes('returned no text'),
  blankFor({ finish: 'stop' }))
check('answer row: an exhausted read budget explains itself',
  blankFor({ toolBudgetExhausted: true, toolCalls: 8, finish: 'stop' }).includes('8 looks'),
  blankFor({ toolBudgetExhausted: true, toolCalls: 8, finish: 'stop' }))
// A tool round that ran out but still produced an answer is flagged, not hidden.
const budgetTree = Exchange({
  message: {
    key: 'a8', role: 'assistant', text: 'Partial answer.',
    metrics: { toolBudgetExhausted: true, toolCalls: 3, inputTokens: 10, outputTokens: 4, llmMs: 900 },
  },
  t: translate,
})
check('answer row: a thinner answer says the read budget ran out',
  collectByClass(budgetTree, 'btw-warn').length === 1
  && walk(budgetTree).texts.join('|').includes('read budget hit'),
  walk(budgetTree).texts.join('|'))
check('answer row: the flag does not fire without the budget flag',
  collectByClass(Exchange({
    message: { key: 'a9', role: 'assistant', text: 'Full.', metrics: { toolCalls: 3, inputTokens: 2, outputTokens: 2, llmMs: 100 } },
    t: translate,
  }), 'btw-warn').length === 0)

// A failed attempt is actionable: the reason, plus a Retry that names its row.
const retriedKeys = []
const failureTree = Exchange({
  message: {
    key: 'a7', role: 'assistant', text: '',
    failure: { reason: 'timeout', message: 'The model did not finish within 300s.' },
    metrics: { inputTokens: 3, outputTokens: 0, llmMs: 300000 },
  },
  t: translate,
  onRetry: key => retriedKeys.push(key),
})
check('failure row: the reason is shown',
  walk(failureTree).texts.join('|').includes('did not finish in time'), walk(failureTree).texts.join('|'))
check('failure row: a row with no text offers no copy control',
  collectByClass(failureTree, 'btw-copy').length === 0, collectByClass(failureTree, 'btw-copy').length)
const retryButton = collectByClass(failureTree, 'btw-retry')[0]
check('failure row: Retry is offered', retryButton !== undefined, collectByClass(failureTree, 'btw-retry').length)
retryButton?.props.onClick()
check('failure row: Retry names the row it belongs to', retriedKeys[0] === 'a7', retriedKeys)
check('empty answer: an explained empty row is retryable too',
  collectByClass(Exchange({
    message: { key: 'a6', role: 'assistant', text: '', metrics: { finish: 'stop' } },
    t: translate,
    onRetry: () => {},
  }), 'btw-retry').length === 1)

// ------------------------------------------------------------------- images

const questionImage = {
  attachmentId: 'sha256:abcd', mediaType: 'image/png', bytes: 10, width: 320, height: 200, name: 'shot.png',
}
check('images: a stored reference becomes a Host url',
  imageUrl('sess-1', questionImage) === '/api/btw/image?session=sess-1&attachment=sha256%3Aabcd',
  imageUrl('sess-1', questionImage))
check('images: a reference without an id never becomes a url',
  imageUrl('sess-1', {}) === '' && imageUrl(undefined, questionImage) === '', imageUrl(undefined, questionImage))

const imageQuestionTree = Exchange({
  message: { key: 'q1', role: 'user', text: 'what is wrong here?', attachments: [questionImage] },
  t: translate,
  sessionId: 'sess-1',
})
const rendered = collectByClass(imageQuestionTree, 'btw-question-image')
check('question row: an attached image is drawn from the Host route',
  rendered.length === 1 && rendered[0].props.src === imageUrl('sess-1', questionImage), rendered[0]?.props)
check('question row: the picture keeps its file name for the hover title',
  rendered[0]?.props.title === 'shot.png', rendered[0]?.props)
check('question row: the text survives next to the picture',
  walk(imageQuestionTree).texts.join('|').includes('what is wrong here?'),
  walk(imageQuestionTree).texts.join('|'))

check('images: only chips that finished reading are sent',
  JSON.stringify(imageParts([
    { status: 'ready', mediaType: 'image/png', data: 'AAA', name: 'a.png' },
    { status: 'reading', mediaType: 'image/png', data: '' },
    { status: 'failed', mediaType: 'image/png', data: 'BBB' },
  ])) === JSON.stringify([{ mediaType: 'image/png', data: 'AAA', name: 'a.png' }]),
  imageParts([{ status: 'ready', mediaType: 'image/png', data: 'AAA', name: 'a.png' }]))
check('images: a nameless image sends no name member',
  JSON.stringify(imageParts([{ status: 'ready', mediaType: 'image/png', data: 'AAA', name: '' }]))
  === JSON.stringify([{ mediaType: 'image/png', data: 'AAA' }]),
  imageParts([{ status: 'ready', mediaType: 'image/png', data: 'AAA', name: '' }]))

const picked = pickImages([{ type: 'image/png' }, { type: 'application/pdf' }, { type: 'image/webp' }], 6)
check('images: the picker keeps rasters and drops everything else',
  picked.files.length === 2 && picked.refusal === null, picked)
check('images: a pick with no image says so',
  pickImages([{ type: 'application/pdf' }], 6).refusal === 'imagesOnly',
  pickImages([{ type: 'application/pdf' }], 6))
check('images: a full question refuses the pick',
  pickImages([{ type: 'image/png' }], 0).refusal === 'imageLimit',
  pickImages([{ type: 'image/png' }], 0))
check('images: an over-full pick is trimmed to the free slots',
  pickImages([{ type: 'image/png' }, { type: 'image/png' }, { type: 'image/png' }], 2).files.length === 2,
  pickImages([{ type: 'image/png' }, { type: 'image/png' }, { type: 'image/png' }], 2))

globalThis.FileReader = class {
  readAsDataURL() {
    this.result = 'data:image/png;base64,iVBORw0KGgo='
    this.onload()
  }
}
const readResult = await readImageFile({ name: 'a.png' })
check('images: reading a file keeps the base64 payload and a preview url',
  readResult.data === 'iVBORw0KGgo=' && readResult.dataUrl.startsWith('data:image/png;base64,'),
  readResult)
delete globalThis.FileReader

check('footer: the budget line names both numbers without a manual',
  limitsLine({ maxExchanges: 20, maxContextMessages: 80 }, translate) === 'replay ≤20 turns · context ≤80 msgs',
  limitsLine({ maxExchanges: 20, maxContextMessages: 80 }, translate))
check('footer: the tooltip spells the character budget out',
  limitsHint({ maxExchanges: 20, maxContextMessages: 80, maxContextChars: 48000 }, translate).includes('48000'),
  limitsHint({ maxExchanges: 20, maxContextMessages: 80, maxContextChars: 48000 }, translate))

// The model chip: short enough to fit, never a dead end.
check('header: a provider prefix the model id repeats is dropped',
  routeLabel({ provider: 'deepseek', model: 'deepseek/deepseek-v4.1-flash' }) === 'deepseek-v4.1-flash',
  routeLabel({ provider: 'deepseek', model: 'deepseek/deepseek-v4.1-flash' }))
check('header: an unrelated provider keeps the whole model id',
  routeLabel({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }) === 'deepseek/deepseek-v4.1-flash',
  routeLabel({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }))
check('header: no route has no label',
  routeLabel(null) === null && routeLabel({ provider: 'x', model: '' }) === null,
  [routeLabel(null), routeLabel({ provider: 'x', model: '' })])
check('header: the tooltip carries provider and model',
  routeTitle({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }) === 'commandcode / deepseek/deepseek-v4.1-flash',
  routeTitle({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }))
check('header: a self-naming model does not repeat its provider',
  routeTitle({ provider: 'deepseek', model: 'deepseek/deepseek-v4.1-flash' }) === 'deepseek/deepseek-v4.1-flash',
  routeTitle({ provider: 'deepseek', model: 'deepseek/deepseek-v4.1-flash' }))

// Smoke-render the panel: the new composer must not depend on Host state that
// has not arrived yet. The stub runs effects inline, so polling is muted first.
const realFetch = globalThis.fetch
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.fetch = async () => { throw new Error('offline test') }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const panelTree = body.component({ sessionId: 'sess-1', useTabInfo: () => ({}), t: translate })
globalThis.fetch = realFetch
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval

const panel = walk(panelTree)
check('panel: renders the composer before Host state arrives',
  panel.tags.includes('form') && panel.tags.includes('textarea'), panel.tags.slice(0, 14))
const fileInput = renderWalkFind(panelTree, 'input')
check('panel: offers a hidden image input with the accepted types',
  fileInput?.props?.type === 'file' && String(fileInput?.props?.accept ?? '').includes('image/png'),
  fileInput?.props)
check('panel: the attach control waits for the Host answer',
  collectByClass(panelTree, 'btw-attach').length === 0, collectByClass(panelTree, 'btw-attach').length)

// A panel whose Host state says images are supported offers the control.
seedNext = {
  ok: true, open: true, busy: false, pending: null, error: null, messages: [],
  totals: { asks: 0 }, tools: { names: [], reason: 'idle' },
  route: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  images: { enabled: true, max: 6, reason: 'ok' },
  limits: { maxExchanges: 20, maxContextMessages: 80, maxContextChars: 48000, maxImages: 6 },
}
globalThis.fetch = async () => { throw new Error('offline test') }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const readyTree = body.component({ sessionId: 'sess-1', useTabInfo: () => ({}), t: translate })
seedNext = undefined
globalThis.fetch = realFetch
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
const readyTexts = walk(readyTree).texts.join('|')
check('panel: the attach control appears once the Host supports images',
  collectByClass(readyTree, 'btw-attach').length === 1, collectByClass(readyTree, 'btw-attach').length)
check('panel: the footer explains the request budget',
  readyTexts.includes('replay ≤20 turns · context ≤80 msgs'), readyTexts.slice(0, 200))
check('panel: the budget line carries the tooltip',
  collectByClass(readyTree, 'btw-limits')[0]?.props.title?.includes('48000'), collectByClass(readyTree, 'btw-limits')[0]?.props)
const routeChip = collectByClass(readyTree, 'btw-route')[0]
check('panel: the model chip shows the model id, not an ellipsized stub',
  (routeChip?.children ?? []).join('') === 'deepseek/deepseek-v4.1-flash', (routeChip?.children ?? []).join(''))
check('panel: the model chip keeps the whole route in its tooltip',
  routeChip?.props?.title === 'Model: commandcode / deepseek/deepseek-v4.1-flash', routeChip?.props?.title)

// The same panel with image input switched off hides the control entirely.
seedNext = {
  ok: true, open: true, busy: false, pending: null, error: null, messages: [],
  totals: { asks: 0 }, tools: { names: [], reason: 'idle' },
  images: { enabled: false, max: 0, reason: 'disabled' },
  limits: { maxExchanges: 20, maxContextMessages: 80, maxContextChars: 48000, maxImages: 0 },
}
globalThis.fetch = async () => { throw new Error('offline test') }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
const offTree = body.component({ sessionId: 'sess-1', useTabInfo: () => ({}), t: translate })
seedNext = undefined
globalThis.fetch = realFetch
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
check('panel: a deployment without images shows no attach control',
  collectByClass(offTree, 'btw-attach').length === 0, collectByClass(offTree, 'btw-attach').length)

openNext = true
const toolsDetail = walk(UsageStrip({
  totals: stripTotals, t: translate, tools: { names: ['read', 'glob'], reason: 'ok' },
}))
check('usage strip: the breakdown names the tools in force',
  toolsDetail.texts.includes('Tools') && toolsDetail.texts.includes('read, glob'),
  toolsDetail.texts.slice(-4))
openNext = true
const noToolsDetail = walk(UsageStrip({ totals: stripTotals, t: translate, tools: { names: [], reason: 'disabled' } }))
check('usage strip: a disabled whitelist names its reason',
  noToolsDetail.texts.includes('off (empty whitelist)'), noToolsDetail.texts.slice(-4))
openNext = true
const notAdmitted = walk(UsageStrip({ totals: stripTotals, t: translate, tools: { names: [], reason: 'not-admitted' } }))
check('usage strip: a session that grants no tools says which reason',
  notAdmitted.texts.includes('off (not granted to this session)'), notAdmitted.texts.slice(-4))

/** Find the first element with one tag in a built tree. */
function renderWalkFind(node, tag) {
  if (node === null || node === undefined || node === false) return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = renderWalkFind(child, tag)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node === 'string' || typeof node === 'number') return undefined
  if (typeof node.type === 'function') return renderWalkFind(node.type({ ...node.props, children: node.children }), tag)
  if (node.type === tag) return node
  for (const child of node.children ?? []) {
    const found = renderWalkFind(child, tag)
    if (found !== undefined) return found
  }
  return undefined
}

/** Collect every element carrying one class name, walking components in place. */
function collectByClass(node, className, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collectByClass(child, className, found)
    return found
  }
  if (typeof node.type === 'function') {
    return collectByClass(node.type({ ...node.props, children: node.children }), className, found)
  }
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes(className)) found.push(node)
  for (const child of node.children ?? []) collectByClass(child, className, found)
  return found
}

// ---------------------------------------------------------------- reporting

const failed = results.filter(result => !result.ok)
for (const result of results) {
  const line = `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`
  process.stdout.write(`${line}${result.ok ? '' : `  -> ${JSON.stringify(result.detail)}`}\n`)
}
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`)
process.exitCode = failed.length === 0 ? 0 : 1
