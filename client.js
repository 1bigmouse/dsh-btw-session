/**
 * Browser half of the Btw side-question bundle.
 *
 * Registers one right-sidebar tab type ("btw"), its body, and a row renderer for
 * the `/btw` command that opens the panel. Every answer the panel shows comes
 * from the Host's temporary thread; this module keeps no copy of its own, so a
 * closed tab leaves nothing behind.
 *
 * Answers are drawn with a Markdown renderer whose rules are copied from the
 * conversation's own assistant body (`dsh-client-ui-chat`'s AssistantMarkdown
 * and the primitives' markdown module): the same design tokens, margins, list
 * indents, table paddings, and code-block chrome. A Harness Client package must
 * not be imported as a module, so the structure is reproduced here under the
 * `btw-md` prefix instead of reusing their component.
 */
window.__ModuleLoader__.load({
  id: 'dsh-btw-session',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /** Tab kind: what `openTab` names and what the Host command shares. */
    const KIND = 'btw'
    /** Tab type identity. The body registers under exactly this key. */
    const TAB_ID = 'dsh-btw-session/tab'
    /** Locale namespace this bundle owns. */
    const NS = 'btwSession'

    const STATE_PATH = '/api/btw/state'
    const ASK_PATH = '/api/btw/ask'
    const RETRY_PATH = '/api/btw/retry'
    const CLOSE_PATH = '/api/btw/close'
    /** Serves one admitted image back to the panel that asked about it. */
    const IMAGE_PATH = '/api/btw/image'
    /** The raster formats the Host admits; the file input offers the same list. */
    const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    /** The panel mirrors Host state; one side answer is one request, so polling is cheap. */
    const POLL_MS = 1500

    /** Flat copy; the locale service holds `Record<string, string>` per namespace. */
    const EN = {
      tabTitle: 'Btw',
      guideTitle: 'Btw side session',
      guideDescription: 'Ask about this conversation without adding to it',
      commandOpened: 'Side question sent to the Btw panel',
      openPanel: 'Open panel',
      header: 'Btw side session',
      headerHint: 'Answers here stay out of this conversation',
      empty: 'Ask anything about this conversation. The answer is built from what is already here, may look up workspace files read-only, and is never added back to this session.',
      emptyMarkup: 'The model wrote a tool call as text instead of answering; that markup was ignored.',
      emptyTruncated: 'The answer was cut off at the output limit before any prose arrived — raise maxOutputTokens.',
      emptyToolBudget: 'The tool rounds ran out after {reads} lookups, and the closing pass returned no text either.',
      emptyError: 'The model call failed before any text was returned.',
      emptyAborted: 'The request was cancelled.',
      emptyNoText: 'The model returned no text for this question.',
      retry: 'Retry',
      retrying: 'Retrying…',
      failureTimeout: 'The model did not finish in time.',
      failureInterrupted: 'The request was cancelled.',
      failureError: 'The model call failed.',
      placeholder: 'Ask a side question…',
      send: 'Ask',
      sending: 'Answering…',
      close: 'Close and forget',
      closeTitle: 'Discard this temporary thread',
      usage: 'Usage',
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
      askCount: '{count} asks',
      cacheHit: 'cache hit {percent}%',
      tokPerSecond: '{tps} tok/s',
      tok: '{value} tok',
      reads: '{count} reads',
      toolList: 'Tools',
      toolOff: 'off',
      toolOffDisabled: 'off (empty whitelist)',
      toolOffNoRegistry: 'off (no tool service)',
      toolOffNotAdmitted: 'off (not granted to this session)',
      toolOffUncloneable: 'off (schema not serializable)',
      toolOffIdle: 'not used yet',
      toolMarkupNote: 'tool call came back as text',
      budgetWarn: 'read budget hit',
      budgetWarnTitle: 'The tool rounds ran out before this answer: it is based on what had been read by then. Raise maxToolRounds for a deeper look.',
      noContext: 'no context sent',
      expand: 'Show usage detail',
      collapse: 'Hide usage detail',
      route: 'Model',
      noRoute: 'no model route',
      unavailable: 'The Host half of this plugin is not active.',
      failed: 'Request failed',
      notKept: 'Nothing is stored — closing this panel discards the thread.',
      copy: 'Copy',
      copied: 'Copied',
      copyAnswer: 'Copy the answer',
      attach: 'Attach image',
      attachHint: 'Attach a screenshot, or paste one into the box',
      imagesOnly: 'Only PNG, JPEG, WebP, or GIF images can be attached.',
      imageLimit: 'At most {count} images per question.',
      imageReading: 'Reading the image…',
      imageFailed: 'could not be read',
      imageRemove: 'Remove this image',
      imageCount: 'Images',
      replay: 'replay',
      contextLimit: 'context',
      chars: 'chars',
      limitsLine: 'replay ≤{replay} turns · context ≤{context} msgs',
      limitsHint: 'Every answer is built from the last {context} messages of this conversation (older ones drop off past {chars} characters) plus the last {replay} questions and answers of this panel.',
    }

    const ZH = {
      tabTitle: '临时会话',
      guideTitle: '临时会话（/btw）',
      guideDescription: '就当前会话提问，且不写回会话上下文',
      commandOpened: '问题已发送到「临时会话」面板',
      openPanel: '打开面板',
      header: '临时会话',
      headerHint: '这里的回答不会进入当前会话',
      empty: '可以问任何关于本次会话的问题。回答基于当前已有上下文，必要时会以只读方式查看工作区文件，且不会写回本会话。',
      emptyMarkup: '模型把工具调用写成了正文，没有给出回答（那部分标记已忽略）。',
      emptyTruncated: '还没输出正文就撞到了输出上限 —— 可以调大 maxOutputTokens。',
      emptyToolBudget: '工具轮数用尽（已读取 {reads} 次），补答那次也没有正文。',
      emptyError: '模型调用在返回正文前就失败了。',
      emptyAborted: '请求已取消。',
      emptyNoText: '模型这次没有返回正文。',
      retry: '重试',
      retrying: '正在重试…',
      failureTimeout: '模型没有在时限内完成。',
      failureInterrupted: '请求已取消。',
      failureError: '模型调用失败。',
      placeholder: '输入一个临时问题…',
      send: '提问',
      sending: '正在回答…',
      close: '关闭并清除',
      closeTitle: '丢弃这次临时会话',
      usage: '用量',
      asks: '提问次数',
      total: '总 tokens',
      input: '未缓存输入',
      cacheRead: '缓存读取',
      cacheWrite: '缓存写入',
      output: '输出',
      reasoning: '推理 tokens',
      context: '发送的上下文',
      latency: '总耗时',
      firstToken: '首字延迟',
      average: '平均每次回答',
      askCount: '{count} 次',
      cacheHit: '缓存命中 {percent}%',
      tokPerSecond: '{tps} tok/s',
      tok: '{value} tok',
      reads: '读取 {count} 次',
      toolList: '工具',
      toolOff: '未启用',
      toolOffDisabled: '未启用（白名单为空）',
      toolOffNoRegistry: '未启用（没有工具服务）',
      toolOffNotAdmitted: '未启用（本会话未授予）',
      toolOffUncloneable: '未启用（参数不可序列化）',
      toolOffIdle: '尚未使用',
      toolMarkupNote: '工具调用未生效',
      budgetWarn: '读取轮数用尽',
      budgetWarnTitle: '工具轮数在成文前用尽，这条回答只基于已读到的内容。想读得更深可以调大 maxToolRounds。',
      noContext: '未带上上下文',
      expand: '展开用量明细',
      collapse: '收起用量明细',
      route: '模型',
      noRoute: '未选择模型',
      unavailable: '插件的 Host 端未启用。',
      failed: '请求失败',
      notKept: '不保存任何内容 —— 关闭面板即丢弃。',
      copy: '复制',
      copied: '已复制',
      copyAnswer: '复制这条回答',
      attach: '附加图片',
      attachHint: '附加一张截图，也可以直接粘贴或拖进来',
      imagesOnly: '只能附加 PNG、JPEG、WebP、GIF 格式的图片。',
      imageLimit: '每个问题最多 {count} 张图片。',
      imageReading: '正在读取图片…',
      imageFailed: '读取失败',
      imageRemove: '移除这张图',
      imageCount: '随请求的图片',
      replay: '重放',
      contextLimit: '上下文',
      chars: '字符',
      limitsLine: '重放 ≤{replay} 轮 · 上下文 ≤{context} 条',
      limitsHint: '每条回答都基于：本会话最近 {context} 条消息（超过 {chars} 字符时从最早的消息丢起）+ 本面板最近 {replay} 轮问答。',
    }

    /** Compact token counts for a narrow column. */
    function fmtTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value < 1000) return String(value)
      if (value < 10000) return `${(value / 1000).toFixed(1)}k`
      if (value < 1000000) return `${Math.round(value / 1000)}k`
      return `${(value / 1000000).toFixed(1)}M`
    }

    /** Compact durations. */
    function fmtMs(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value < 1000) return `${Math.round(value)}ms`
      return `${(value / 1000).toFixed(1)}s`
    }

    /** Call one Host route and normalize its JSON answer. */
    async function call(path, options = {}) {
      const response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body,
        keepalive: options.keepalive === true,
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json().catch(() => null)
      if (payload === null) throw new Error('empty response')
      return payload
    }

    // --------------------------------------------------------------- images

    /**
     * Read one picked image into canonical base64 and a preview URL.
     *
     * The bytes travel in the ask body and the Host stores them through the same
     * admission gate an ordinary prompt uses, so this side only has to move
     * bytes; it never decides whether the image is acceptable.
     * @param file - the browser `File` behind the file input, paste, or drop.
     * @returns `data` for the request and `dataUrl` for the chip preview.
     */
    function readImageFile(file) {
      return new Promise((resolve, reject) => {
        if (typeof globalThis.FileReader !== 'function') {
          reject(new Error('This browser cannot read local files.'))
          return
        }
        const reader = new globalThis.FileReader()
        reader.onerror = () => { reject(reader.error ?? new Error('The image could not be read.')) }
        reader.onload = () => {
          const url = typeof reader.result === 'string' ? reader.result : ''
          const comma = url.indexOf(',')
          if (comma < 0) {
            reject(new Error('The image could not be read.'))
            return
          }
          resolve({ data: url.slice(comma + 1), dataUrl: url })
        }
        reader.readAsDataURL(file)
      })
    }

    /**
     * The Host route that serves one admitted image back to this panel.
     *
     * The thread keeps durable references, not bytes, so a reloaded panel still
     * draws the picture it asked about. The route only answers for references
     * this thread already admitted.
     */
    function imageUrl(sessionId, ref) {
      const id = typeof ref?.attachmentId === 'string' ? ref.attachmentId : ''
      if (id === '' || typeof sessionId !== 'string' || sessionId === '') return ''
      return `${IMAGE_PATH}?session=${encodeURIComponent(sessionId)}&attachment=${encodeURIComponent(id)}`
    }

    /** The `images` member of one ask request, from the chips that finished reading. */
    function imageParts(items) {
      const parts = []
      for (const item of items ?? []) {
        if (item?.status !== 'ready' || typeof item.data !== 'string' || item.data === '') continue
        parts.push({
          mediaType: item.mediaType,
          data: item.data,
          ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
        })
      }
      return parts
    }
    /**
     * Decide which picked files the next question may carry.
     *
     * The side question has no file drafts — only rasters it can show the model
     * directly — so anything else is dropped here rather than failing at the Host.
     * @param fileList - what the picker, a paste, or a drop offered.
     * @param room - image slots left under the Host's cap.
     * @returns the images to read plus the copy key to complain with, if any.
     */
    function pickImages(fileList, room) {
      const picked = Array.from(fileList ?? [])
      const files = picked.filter(file => IMAGE_TYPES.includes(file?.type))
      if (files.length === 0) return { files: [], refusal: picked.length === 0 ? null : 'imagesOnly' }
      if (room <= 0) return { files: [], refusal: 'imageLimit' }
      return { files: files.slice(0, room), refusal: files.length > room ? 'imageLimit' : null }
    }

    /** The model reading for the header chip, without a provider prefix the id repeats. */
    function routeLabel(route) {
      if (route === null || route === undefined) return null
      const model = String(route.model ?? '')
      if (model === '') return null
      const provider = typeof route.provider === 'string' ? route.provider : ''
      const prefix = `${provider}/`
      return provider !== '' && model.startsWith(prefix) && model.length > prefix.length
        ? model.slice(prefix.length)
        : model
    }

    /** The full route for the chip's tooltip; the chip itself may be ellipsized. */
    function routeTitle(route) {
      if (route === null || route === undefined) return null
      const model = String(route.model ?? '')
      const provider = typeof route.provider === 'string' ? route.provider : ''
      if (model === '') return provider === '' ? null : provider
      return provider === '' || model.startsWith(`${provider}/`) ? model : `${provider} / ${model}`
    }

    /** The footer's budget line: what each answer is actually assembled from. */
    function limitsLine(limits, t) {
      return t('limitsLine', {
        replay: countOf(limits?.maxExchanges),
        context: countOf(limits?.maxContextMessages),
      })
    }

    /** The same numbers spelled out, for the footer's tooltip. */
    function limitsHint(limits, t) {
      return t('limitsHint', {
        replay: countOf(limits?.maxExchanges),
        context: countOf(limits?.maxContextMessages),
        chars: countOf(limits?.maxContextChars),
      })
    }

    /** A non-negative integer from a Host-supplied number. */
    function countOf(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
    }

    // ------------------------------------------------------------ markdown

    /** An opening code fence: indent, marker run, and info string. */
    const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/
    /** A themed break: three or more of one character, spaces allowed between. */
    const THEMATIC = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
    /** An ATX heading. */
    const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
    /** One list item line. */
    const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/
    /** A table delimiter row, which is what makes the previous line a header. */
    const TABLE_DELIM = /^\s*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?\s*$/

    /** Leading width of a line, counting a tab as four columns. */
    function indentOf(line) {
      let width = 0
      for (const char of line) {
        if (char === ' ') width += 1
        else if (char === '\t') width += 4
        else break
      }
      return width
    }

    /** Drop up to `width` leading columns. */
    function dedent(line, width) {
      let index = 0
      let remaining = width
      while (index < line.length && remaining > 0) {
        const char = line[index]
        if (char === ' ') { remaining -= 1; index += 1; continue }
        if (char === '\t') { remaining -= 4; index += 1; continue }
        break
      }
      return line.slice(index)
    }

    /** Whether a line starts a block that interrupts a paragraph. */
    function startsBlock(line) {
      return FENCE_OPEN.test(line)
        || HEADING.test(line)
        || THEMATIC.test(line)
        || /^\s{0,3}>/.test(line)
        || ITEM.test(line)
    }

    /** Split a table row on unescaped pipes. */
    function splitRow(line) {
      const text = line.trim().replace(/^\|/, '').replace(/\|$/, '')
      const cells = []
      let cell = ''
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (char === '\\' && text[index + 1] === '|') { cell += '|'; index += 1; continue }
        if (char === '|') { cells.push(cell.trim()); cell = ''; continue }
        cell += char
      }
      cells.push(cell.trim())
      return cells
    }

    /** Whether lines[start] heads a table, judged by the delimiter under it. */
    function isTableStart(lines, start) {
      if (start + 1 >= lines.length) return false
      if (!lines[start].includes('|')) return false
      return TABLE_DELIM.test(lines[start + 1])
    }

    /** One GFM table: header cells, per-column alignment, and body rows. */
    function parseTable(lines, start) {
      const header = splitRow(lines[start])
      const alignments = splitRow(lines[start + 1]).map(cell => {
        const left = cell.startsWith(':')
        const right = cell.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return null
      })
      const rows = []
      let index = start + 2
      while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      return { block: { kind: 'table', header, alignments, rows }, next: index }
    }

    /** One list, with nested blocks parsed from each item's dedented body. */
    function parseList(lines, start) {
      const first = ITEM.exec(lines[start])
      const baseIndent = first[1].length
      const ordered = /\d/.test(first[2])
      const startNumber = ordered ? Number.parseInt(first[2], 10) : 1
      const items = []
      let index = start
      let number = startNumber
      while (index < lines.length) {
        const match = ITEM.exec(lines[index])
        if (match === null) break
        if (match[1].length !== baseIndent) break
        if (/\d/.test(match[2]) !== ordered) break
        const contentColumn = baseIndent + match[2].length + 1
        const body = [match[3]]
        index += 1
        while (index < lines.length) {
          const raw = lines[index]
          if (raw.trim() === '') {
            let ahead = index + 1
            while (ahead < lines.length && lines[ahead].trim() === '') ahead += 1
            if (ahead < lines.length && indentOf(lines[ahead]) > baseIndent) { body.push(''); index += 1; continue }
            break
          }
          if (indentOf(raw) > baseIndent) {
            body.push(dedent(raw, Math.min(indentOf(raw), contentColumn)))
            index += 1
            continue
          }
          break
        }
        items.push({ number: ordered ? number : null, blocks: parseBlocks(body.join('\n')) })
        if (ordered) number += 1
        // A blank run only continues the list when another item at the same
        // indent follows it; otherwise the list ends here.
        let ahead = index
        while (ahead < lines.length && lines[ahead].trim() === '') ahead += 1
        if (ahead === index) continue
        const next = ahead < lines.length ? ITEM.exec(lines[ahead]) : null
        if (next !== null && next[1].length === baseIndent && /\d/.test(next[2]) === ordered) {
          index = ahead
          continue
        }
        return { block: { kind: 'list', ordered, start: startNumber, items }, next: index }
      }
      return { block: { kind: 'list', ordered, start: startNumber, items }, next: index }
    }

    /**
     * Parse one Markdown source into block nodes.
     *
     * The supported vocabulary is what a chat answer actually uses: fenced code,
     * ATX headings, thematic breaks, block quotes, nested ordered/unordered
     * lists, GFM tables, and paragraphs. HTML is never interpreted.
     */
    function parseBlocks(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        if (line.trim() === '') { index += 1; continue }

        const fence = FENCE_OPEN.exec(line)
        if (fence !== null) {
          const [, indent, marker, lang] = fence
          const closer = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
          const body = []
          index += 1
          while (index < lines.length && !closer.test(lines[index])) {
            body.push(dedent(lines[index], indent.length))
            index += 1
          }
          index += 1
          blocks.push({ kind: 'code', lang: lang ?? '', code: body.join('\n') })
          continue
        }

        const heading = HEADING.exec(line)
        if (heading !== null) {
          blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
          index += 1
          continue
        }

        if (THEMATIC.test(line)) {
          blocks.push({ kind: 'hr' })
          index += 1
          continue
        }

        if (/^\s{0,3}>/.test(line)) {
          const inner = []
          while (index < lines.length) {
            const raw = lines[index]
            if (/^\s{0,3}>/.test(raw)) {
              inner.push(raw.replace(/^\s{0,3}>[ \t]?/, ''))
              index += 1
              continue
            }
            // Lazy continuation: prose directly under a quote belongs to it.
            if (raw.trim() !== '' && !startsBlock(raw) && inner.length > 0 && inner[inner.length - 1].trim() !== '') {
              inner.push(raw)
              index += 1
              continue
            }
            break
          }
          blocks.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n')) })
          continue
        }

        if (isTableStart(lines, index)) {
          const parsed = parseTable(lines, index)
          blocks.push(parsed.block)
          index = parsed.next
          continue
        }

        if (ITEM.test(line)) {
          const parsed = parseList(lines, index)
          blocks.push(parsed.block)
          index = parsed.next
          continue
        }

        const paragraph = []
        while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index])) {
          if (isTableStart(lines, index)) break
          paragraph.push(lines[index])
          index += 1
        }
        if (paragraph.length === 0) {
          // Never stall: a line that starts a block but reached this branch is
          // prose as far as this parser is concerned.
          blocks.push({ kind: 'paragraph', text: lines[index] })
          index += 1
          continue
        }
        blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
      }
      return blocks
    }

    /** Bare URL matcher used for autolinking. */
    const BARE_URL = /^(?:https?:\/\/|mailto:)[^\s<>()\]]+/

    /**
     * Destinations the panel is willing to open: the web and mail, nothing else.
     * A model can write any string as a link target, so `file:`, `data:` and
     * `javascript:` stay plain text; relative paths stay text too, because they
     * would resolve against the Harness page rather than the workspace.
     */
    const SAFE_HREF = /^(?:https?:\/\/|mailto:)/i

    /**
     * Render one inline Markdown run.
     *
     * Escapes, code spans, images, links, emphasis, strikethrough, autolinks and
     * hard line breaks. Every node is built as a React element, so answer text
     * can never become markup; link and image destinations are further limited
     * to `http:`, `https:` and `mailto:`.
     */
    function renderInline(text, keyBase, depth = 0) {
      const nodes = []
      let buffer = ''
      let index = 0
      let counter = 0
      if (depth > 8) return [text]
      const flush = () => { if (buffer !== '') { nodes.push(buffer); buffer = '' } }
      const push = node => { flush(); nodes.push(node) }
      const key = () => `${keyBase}:i${counter++}`

      while (index < text.length) {
        const char = text[index]

        if (char === '\\' && index + 1 < text.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(text[index + 1])) {
          buffer += text[index + 1]
          index += 2
          continue
        }

        if (char === '\n') {
          push(h('br', { key: key() }))
          index += 1
          continue
        }

        if (char === '`') {
          const run = /^`+/.exec(text.slice(index))[0]
          const close = text.indexOf(run, index + run.length)
          if (close !== -1) {
            push(h('code', { key: key() }, text.slice(index + run.length, close)))
            index = close + run.length
            continue
          }
        }

        if (char === '!' && text[index + 1] === '[') {
          const image = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/.exec(text.slice(index))
          if (image !== null) {
            const label = image[1] !== '' ? image[1] : image[3] ?? image[2]
            if (SAFE_HREF.test(image[2])) {
              push(h('a', {
                key: key(), href: image[2], target: '_blank', rel: 'noreferrer noopener',
              }, label))
            } else {
              push(label)
            }
            index += image[0].length
            continue
          }
        }

        if (char === '[') {
          const link = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(text.slice(index))
          if (link !== null) {
            const inner = renderInline(link[1], `${keyBase}:a${counter}`, depth + 1)
            if (SAFE_HREF.test(link[2])) {
              push(h('a', {
                key: key(), href: link[2], target: '_blank', rel: 'noreferrer noopener',
              }, inner))
            } else {
              // A destination the panel will not open keeps its label as text.
              push(h('span', { key: key() }, inner))
            }
            index += link[0].length
            continue
          }
        }

        if (char === '*') {
          const strong = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(text.slice(index))
          if (strong !== null) {
            push(h('strong', { key: key() }, renderInline(strong[1], `${keyBase}:s${counter}`, depth + 1)))
            index += strong[0].length
            continue
          }
        }

        if (char === '_') {
          const strong = /^__(?=\S)([\s\S]*?\S)__/.exec(text.slice(index))
          if (strong !== null) {
            push(h('strong', { key: key() }, renderInline(strong[1], `${keyBase}:s${counter}`, depth + 1)))
            index += strong[0].length
            continue
          }
        }

        if (char === '~' && text[index + 1] === '~') {
          const del = /^~~(?=\S)([\s\S]*?\S)~~/.exec(text.slice(index))
          if (del !== null) {
            push(h('del', { key: key() }, renderInline(del[1], `${keyBase}:d${counter}`, depth + 1)))
            index += del[0].length
            continue
          }
        }

        if (char === '*' || char === '_') {
          const em = char === '*'
            ? /^\*(?=\S)([\s\S]*?\S)\*/.exec(text.slice(index))
            : /^_(?=\S)([\s\S]*?\S)_/.exec(text.slice(index))
          if (em !== null) {
            push(h('em', { key: key() }, renderInline(em[1], `${keyBase}:e${counter}`, depth + 1)))
            index += em[0].length
            continue
          }
        }

        if (char === '<') {
          const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(text.slice(index))
          if (auto !== null) {
            push(h('a', {
              key: key(), href: auto[1], target: '_blank', rel: 'noreferrer noopener',
            }, auto[1]))
            index += auto[0].length
            continue
          }
        }

        if ((char === 'h' || char === 'm') && (index === 0 || /[\s(（]/.test(text[index - 1]))) {
          const bare = BARE_URL.exec(text.slice(index))
          if (bare !== null) {
            push(h('a', {
              key: key(), href: bare[0], target: '_blank', rel: 'noreferrer noopener',
            }, bare[0]))
            index += bare[0].length
            continue
          }
        }

        buffer += char
        index += 1
      }
      flush()
      return nodes
    }

    /** Keywords shared by the C-like family; unknown code is left uncoloured. */
    const C_KEYWORDS = 'abstract as async await break case catch class const continue debugger default delete do else enum export extends false final finally for from function if implements import in instanceof interface let namespace new null of package private protected public readonly return static super switch this throw throws true try type typeof undefined var void while yield'
    /** Keywords for the `#`-comment family (Python, shell, Ruby, TOML). */
    const HASH_KEYWORDS = 'and as assert async await break class continue def del elif else except exec finally for from global if import in is lambda None nonlocal not or pass print raise return True try while with yield then fi do done esac elif case function local done'
    /** Languages that use `//` and block comments. */
    const SLASH_LANGUAGES = new Set(['js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'json', 'jsonc', 'java', 'c', 'h', 'cpp', 'c++', 'cs', 'csharp', 'go', 'rust', 'rs', 'swift', 'kotlin', 'kt', 'php', 'sql', 'scss', 'css', 'groovy', 'dart'])
    /** Languages that use `#` comments. */
    const HASH_LANGUAGES = new Set(['py', 'python', 'sh', 'shell', 'bash', 'zsh', 'console', 'shell-session', 'yaml', 'yml', 'toml', 'ruby', 'rb', 'r', 'perl', 'pl', 'dockerfile', 'makefile', 'ini', 'conf', 'env', 'properties'])

    /** One compiled scanner per family; built once because answers are re-rendered. */
    const SCANNERS = new Map()

    /** Build the scanner for one comment family. */
    function scannerFor(family) {
      const cached = SCANNERS.get(family)
      if (cached !== undefined) return cached
      const keywords = family === 'hash' ? HASH_KEYWORDS : C_KEYWORDS
      const comment = family === 'hash' ? '#[^\\n]*' : '(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)'
      const pattern = `(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d[\\d_.]*)\\b|\\b(${keywords.split(' ').join('|')})\\b`
      let scanner
      try {
        scanner = new RegExp(pattern, 'g')
      } catch {
        scanner = null
      }
      SCANNERS.set(family, scanner)
      return scanner
    }

    /** Which comment family one fence language uses, or null when uncoloured. */
    function familyOf(lang) {
      const name = String(lang ?? '').toLowerCase().split(/[\s,{]/)[0]
      if (SLASH_LANGUAGES.has(name)) return 'slash'
      if (HASH_LANGUAGES.has(name)) return 'hash'
      return null
    }

    /**
     * Split one code block into coloured runs.
     *
     * Deliberately small: comments, strings, numbers, and keywords, which is what
     * makes a snippet read as code at panel width. Unsupported languages and any
     * scanner failure return the source unchanged.
     */
    function highlight(code, lang) {
      const family = familyOf(lang)
      if (family === null) return [{ text: String(code ?? ''), kind: null }]
      const scanner = scannerFor(family)
      if (scanner === null) return [{ text: String(code ?? ''), kind: null }]
      const source = String(code ?? '')
      const runs = []
      let last = 0
      scanner.lastIndex = 0
      let match = scanner.exec(source)
      while (match !== null) {
        if (match.index > last) runs.push({ text: source.slice(last, match.index), kind: null })
        const kind = match[1] !== undefined ? 'com' : match[2] !== undefined ? 'str' : match[3] !== undefined ? 'num' : 'kw'
        runs.push({ text: match[0], kind })
        last = match.index + match[0].length
        if (match[0] === '') scanner.lastIndex += 1
        match = scanner.exec(source)
      }
      if (last < source.length) runs.push({ text: source.slice(last), kind: null })
      return runs
    }

    /** One fenced code block: language banner, copy control, and coloured source. */
    function CodeBlock({ lang, code, t }) {
      const [copied, setCopied] = useState(false)
      const copy = useCallback(() => {
        const clipboard = globalThis.navigator?.clipboard
        if (clipboard?.writeText === undefined) return
        void clipboard.writeText(code).then(() => {
          setCopied(true)
          setTimeout(() => { setCopied(false) }, 1200)
        }).catch(() => {})
      }, [code])
      const runs = useMemo(() => highlight(code, lang), [code, lang])
      return h('div', { className: 'btw-md-code' }, [
        h('div', { key: 'banner', className: 'btw-md-banner' }, [
          h('span', { key: 'lang', className: 'btw-md-lang' }, lang === '' ? 'text' : lang),
          h('button', {
            key: 'copy', type: 'button', className: 'btw-md-copy', onClick: copy,
          }, copied ? t('copied') : t('copy')),
        ]),
        h('pre', { key: 'pre', className: 'btw-md-pre' }, h('code', null, runs.map((run, index) => (
          run.kind === null
            ? run.text
            : h('span', { key: `t${index}`, className: `btw-tok-${run.kind}` }, run.text)
        )))),
      ])
    }

    /** Render parsed blocks as React nodes. */
    function renderBlocks(blocks, prefix, t) {
      return blocks.map((block, index) => {
        const key = `${prefix}:${index}`
        switch (block.kind) {
          case 'heading': {
            const level = Math.min(6, Math.max(1, block.level))
            return h(`h${level}`, { key }, renderInline(block.text, key))
          }
          case 'code':
            return h(CodeBlock, { key, lang: block.lang, code: block.code, t })
          case 'hr':
            return h('hr', { key })
          case 'quote':
            return h('blockquote', { key }, renderBlocks(block.blocks, key, t))
          case 'list': {
            const tag = block.ordered ? 'ol' : 'ul'
            const props = { key }
            if (block.ordered && block.start !== 1) props.start = block.start
            return h(tag, props, block.items.map((item, itemIndex) => {
              const itemKey = `${key}:${itemIndex}`
              const first = item.blocks[0]
              const task = first !== undefined && first.kind === 'paragraph'
                ? /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(first.text)
                : null
              if (task === null) return h('li', { key: itemKey }, renderBlocks(item.blocks, itemKey, t))
              const rest = [{ kind: 'paragraph', text: task[2] }, ...item.blocks.slice(1)]
              return h('li', { key: itemKey, className: 'btw-md-task' }, [
                h('input', {
                  key: 'box', type: 'checkbox', checked: task[1].toLowerCase() === 'x', readOnly: true,
                }),
                h('span', { key: 'text' }, renderBlocks(rest, itemKey, t)),
              ])
            }))
          }
          case 'table':
            return h('div', { key, className: 'btw-md-tablescroll' }, h('table', null, [
              h('thead', { key: 'head' }, h('tr', null, block.header.map((cell, cellIndex) =>
                h('th', {
                  key: `${key}:h${cellIndex}`,
                  style: block.alignments[cellIndex] === null || block.alignments[cellIndex] === undefined
                    ? undefined
                    : { textAlign: block.alignments[cellIndex] },
                }, renderInline(cell, `${key}:h${cellIndex}`))))),
              h('tbody', { key: 'body' }, block.rows.map((row, rowIndex) =>
                h('tr', { key: `${key}:r${rowIndex}` }, row.map((cell, cellIndex) =>
                  h('td', {
                    key: `${key}:r${rowIndex}c${cellIndex}`,
                    style: block.alignments[cellIndex] === null || block.alignments[cellIndex] === undefined
                      ? undefined
                      : { textAlign: block.alignments[cellIndex] },
                  }, renderInline(cell, `${key}:r${rowIndex}c${cellIndex}`)))))),
            ]))
          case 'paragraph':
            return h('p', { key }, renderInline(block.text, key))
          default:
            return h('p', { key }, renderInline(String(block.text ?? ''), key))
        }
      })
    }

    /** Build one answer body: parsed blocks inside the conversation's prose shell. */
    function renderMarkdown(text, t) {
      return h('div', { className: 'btw-md' }, renderBlocks(parseBlocks(text), 'md', t))
    }

    /** One Markdown answer body, parsed once per text change. */
    function Markdown({ text, t }) {
      return useMemo(() => renderMarkdown(text, t), [text, t])
    }

    // --------------------------------------------------------------- panel

    /** A speedometer glyph for the activity reading. */
    function GaugeIcon() {
      return h('svg', {
        viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, [
        h('path', { key: 'dial', d: 'M2.2 10.2a4.8 4.8 0 0 1 9.6 0' }),
        h('path', { key: 'needle', d: 'M7 10.2 9.7 7.1' }),
      ])
    }

    /** A stacked-disk glyph for the token reading. */
    function DatabaseIcon() {
      return h('svg', {
        viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, [
        h('ellipse', { key: 'top', cx: 7, cy: 3.7, rx: 4.5, ry: 1.9 }),
        h('path', { key: 'left', d: 'M2.5 3.7v6.6' }),
        h('path', { key: 'right', d: 'M11.5 3.7v6.6' }),
        h('path', { key: 'mid', d: 'M2.5 7c0 1.05 2.01 1.9 4.5 1.9S11.5 8.05 11.5 7' }),
        h('path', { key: 'base', d: 'M2.5 10.3c0 1.05 2.01 1.9 4.5 1.9s4.5-.85 4.5-1.9' }),
      ])
    }

    /** The disclosure chevron; the stylesheet rotates it while the detail is open. */
    function ChevronIcon() {
      return h('svg', {
        viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M3.6 5.6 7 9l3.4-3.4' }))
    }

    /** A paperclip glyph for the attach control. */
    function ClipIcon() {
      return h('svg', {
        viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M5.1 7.6 8.4 4.3a1.9 1.9 0 0 1 2.7 2.7l-4 4a3.1 3.1 0 0 1-4.4-4.4l4.2-4.2' }))
    }

    /** One decimal below ten, whole numbers above, so a narrow pill stays stable. */
    function fmtRate(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
      return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
    }

    /**
     * Fold the side thread's totals into the readings the strip shows.
     *
     * Prompt-side billing is the three disjoint buckets the conversation's own
     * usage pill uses — uncached input, cache read, cache write — so the total
     * and the cache-hit share mean the same thing here as in the main session.
     * @param totals - the thread's running totals from the Host.
     * @returns display-ready figures.
     */
    function usageSummary(totals) {
      const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      const asks = number(totals?.asks)
      const uncached = number(totals?.inputTokens)
      const cacheRead = number(totals?.cacheReadTokens)
      const cacheWrite = number(totals?.cacheWriteTokens)
      const output = number(totals?.outputTokens)
      const reasoning = number(totals?.reasoningTokens)
      const billedInput = uncached + cacheRead + cacheWrite
      const total = billedInput + output
      let percent = billedInput > 0 ? Math.round((cacheRead / billedInput) * 1000) / 10 : null
      // A partial hit never reports a full hit after rounding.
      if (percent !== null && percent >= 100 && cacheRead < billedInput) percent = 99.9
      const llmMs = number(totals?.llmMs)
      const ttftMs = number(totals?.ttftMs)
      const decodeMs = Math.max(1, llmMs - ttftMs)
      return {
        asks,
        uncached,
        cacheRead,
        cacheWrite,
        output,
        reasoning,
        billedInput,
        total,
        percent,
        llmMs,
        ttftMs,
        tps: output > 0 ? output / (decodeMs / 1000) : null,
        contextChars: number(totals?.contextChars),
        images: number(totals?.images),
      }
    }

    /** Which read-only tools this thread is using, or why it has none. */
    function toolReading(tools, t) {
      if (Array.isArray(tools?.names) && tools.names.length > 0) return tools.names.join(', ')
      const key = {
        'disabled': 'toolOffDisabled',
        'no-registry': 'toolOffNoRegistry',
        'not-admitted': 'toolOffNotAdmitted',
        'uncloneable': 'toolOffUncloneable',
        'idle': 'toolOffIdle',
      }[tools?.reason]
      return t(key ?? 'toolOff')
    }

    /** One pill: a glyph plus one or two readings joined by a separator glyph. */
    function pill(stat, Icon, readings) {
      const children = [h(Icon, { key: 'icon' })]
      readings.forEach((text, index) => {
        if (index > 0) children.push(h('span', { key: `sep${index}`, className: 'btw-sep', 'aria-hidden': true }, '·'))
        children.push(h('span', { key: `read${index}`, className: 'btw-pill-label' }, text))
      })
      return h('span', { key: stat, className: 'btw-pill', 'data-btw-stat': stat }, children)
    }

    /**
     * The side thread's own token accounting.
     *
     * Collapsed it is one reading row — questions and decode speed, then tokens
     * and cache hit — shaped like the conversation's composer statistics pills;
     * pressing it reveals the full breakdown in the same `dl` skin the session
     * statistics dialog uses.
     */
    function UsageStrip({ totals, t, tools }) {
      const [open, setOpen] = useState(false)
      const summary = useMemo(() => usageSummary(totals), [totals])
      if (summary.asks === 0) return null
      const speed = fmtRate(summary.tps)
      const activity = [t('askCount', { count: summary.asks })]
      if (speed !== null) activity.push(t('tokPerSecond', { tps: speed }))
      const usage = [t('tok', { value: fmtTokens(summary.total) })]
      if (summary.percent !== null) usage.push(t('cacheHit', { percent: summary.percent }))

      const rows = []
      const add = (label, value) => { rows.push([label, value]) }
      add(t('asks'), String(summary.asks))
      add(t('total'), t('tok', { value: fmtTokens(summary.total) }))
      add(t('input'), fmtTokens(summary.uncached))
      add(t('cacheRead'), fmtTokens(summary.cacheRead))
      if (summary.cacheWrite !== 0) add(t('cacheWrite'), fmtTokens(summary.cacheWrite))
      add(t('output'), fmtTokens(summary.output))
      if (summary.reasoning !== 0) add(t('reasoning'), fmtTokens(summary.reasoning))
      add(t('average'), `${fmtTokens(Math.round(summary.uncached / summary.asks))} / ${fmtTokens(Math.round(summary.output / summary.asks))}`)
      add(t('latency'), fmtMs(summary.llmMs))
      add(t('firstToken'), fmtMs(summary.ttftMs / summary.asks))
      add(t('context'), `${fmtTokens(summary.contextChars)} ${t('chars')}`)
      if (summary.images !== 0) add(t('imageCount'), String(summary.images))
      add(t('toolList'), toolReading(tools, t))

      return h('section', { className: 'btw-usage' }, [
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'btw-pills',
          'aria-expanded': open,
          'aria-label': t('usage'),
          title: open ? t('collapse') : t('expand'),
          onClick: () => { setOpen(value => !value) },
        }, [
          pill('activity', GaugeIcon, activity),
          pill('usage', DatabaseIcon, usage),
          h('span', {
            key: 'chevron',
            className: 'btw-chevron',
            'data-open': open ? 'true' : undefined,
            'aria-hidden': true,
          }, h(ChevronIcon)),
        ]),
        open
          ? h('dl', { key: 'details', className: 'btw-details' }, rows.flatMap(([label, value], index) => [
            h('dt', { key: `t${index}` }, label),
            h('dd', { key: `d${index}` }, value),
          ]))
          : null,
      ])
    }

    /** Why an answer carries no text, phrased for the reader. */
    function emptyReason(metrics, t) {
      if (metrics?.toolMarkup === true) return t('emptyMarkup')
      // The tool rounds ran out and the closing, tool-free pass had nothing to say.
      if (metrics?.toolBudgetExhausted === true) {
        return t('emptyToolBudget', { reads: typeof metrics.toolCalls === 'number' ? metrics.toolCalls : 0 })
      }
      // The provider said it wanted tools but no call block arrived: the same
      // desync that produces markup in the prose.
      if (metrics?.finish === 'tool-calls' && (metrics.toolCalls ?? 0) === 0) return t('emptyMarkup')
      if (metrics?.finish === 'max-tokens') return t('emptyTruncated')
      if (metrics?.finish === 'error') return t('emptyError')
      if (metrics?.finish === 'aborted') return t('emptyAborted')
      return t('emptyNoText')
    }

    /** Why one attempt failed, phrased for the reader. */
    function failureText(failure, t) {
      const key = {
        timeout: 'failureTimeout',
        interrupted: 'failureInterrupted',
        error: 'failureError',
      }[failure?.reason]
      return t(key ?? 'failureError')
    }

    /**
     * One answer body: the answer, or the reason there is none plus a way to
     * try again.
     *
     * A failed attempt is a row the user can act on, not a dead end: the Host
     * keeps the question, so Retry re-answers the same question rather than
     * asking the panel to resend anything.
     */
    function AnswerBody({ message, t, onRetry }) {
      const failure = message.failure ?? null
      if (failure === null && message.text !== '') return h(Markdown, { text: message.text, t })
      const reason = failure === null ? emptyReason(message.metrics, t) : failureText(failure, t)
      return h('div', { className: 'btw-failure' }, [
        h('p', {
          key: 'reason',
          className: 'btw-empty-answer',
          ...(failure?.message === undefined ? {} : { title: String(failure.message) }),
        }, reason),
        h('button', {
          key: 'retry',
          type: 'button',
          className: 'btw-retry',
          onClick: () => { if (typeof onRetry === 'function') onRetry(message.key) },
        }, t('retry')),
      ])
    }

    /** One exchange row: the question, or the answer with its own measurement. */
    function Exchange({ message, t, sessionId, onRetry }) {
      const isUser = message.role === 'user'
      const [copied, setCopied] = useState(false)
      const metrics = message.metrics
      // The question's own pictures: durable references, drawn through the Host
      // route, so a reloaded panel still shows what the answer was looking at.
      const images = (Array.isArray(message.attachments) ? message.attachments : [])
        .map((ref, index) => ({
          key: `${typeof ref?.attachmentId === 'string' ? ref.attachmentId : 'image'}:${index}`,
          src: imageUrl(sessionId, ref),
          name: typeof ref?.name === 'string' ? ref.name : '',
        }))
        .filter(entry => entry.src !== '')
      const parts = []
      if (!isUser && metrics !== null && metrics !== undefined) {
        parts.push(`${t('input')} ${fmtTokens(metrics.inputTokens)}`)
        parts.push(`${t('output')} ${fmtTokens(metrics.outputTokens)}`)
        if (typeof metrics.rounds === 'number' && metrics.rounds > 1) parts.push(`${metrics.rounds}×`)
        if (typeof metrics.toolCalls === 'number' && metrics.toolCalls > 0) {
          parts.push(t('reads', { count: metrics.toolCalls }))
        }
        // A zero here means the parent conversation contributed nothing; without
        // this marker that looks like an ordinary terse answer.
        if (metrics.contextMessages === 0) parts.push(t('noContext'))
        parts.push(fmtMs(metrics.llmMs))
      }
      const meta = parts.length === 0 ? null : parts.join(' · ')
      const copy = () => {
        const clipboard = globalThis.navigator?.clipboard
        if (clipboard?.writeText === undefined) return
        void clipboard.writeText(message.text).then(() => {
          setCopied(true)
          setTimeout(() => { setCopied(false) }, 1200)
        }).catch(() => {})
      }
      return h('article', { className: `btw-exchange btw-${isUser ? 'question' : 'answer'}` }, [
        isUser
          ? h('div', {
            key: 'body',
            className: images.length === 0 ? 'btw-question-body' : 'btw-question-body btw-question-body-media',
          }, [
            images.length === 0 ? null : h('div', { key: 'images', className: 'btw-question-images' },
              images.map(entry => h('img', {
                key: entry.key,
                className: 'btw-question-image',
                src: entry.src,
                alt: entry.name,
                title: entry.name === '' ? t('imageCount') : entry.name,
              }))),
            h('span', { key: 'text', className: 'btw-question-text' }, message.text),
          ])
          : h(AnswerBody, { key: 'body', message, t, onRetry }),
        isUser
          ? null
          : h('footer', { key: 'meta', className: 'btw-exchange-footer' }, [
            meta === null ? null : h('span', { key: 'm', className: 'btw-exchange-meta' }, meta),
            metrics?.toolMarkup === true
              ? h('span', { key: 'w', className: 'btw-warn', title: t('toolMarkupNote') }, t('toolMarkupNote'))
              : null,
            // An answer produced after the tool rounds ran out used less than the
            // model asked for; the reader deserves to know why it is thinner.
            metrics?.toolBudgetExhausted === true && message.text !== ''
              ? h('span', { key: 'b', className: 'btw-warn', title: t('budgetWarnTitle') }, t('budgetWarn'))
              : null,
            // Nothing to copy when the row carries a reason instead of an answer;
            // Retry lives in the body block.
            message.text === '' ? null : h('button', {
              key: 'copy',
              type: 'button',
              className: 'btw-copy',
              title: t('copyAnswer'),
              onClick: copy,
            }, copied ? t('copied') : t('copy')),
          ]),
      ])
    }

    /** The right-sidebar tab body. */
    function BtwBody(props) {
      const { sessionId, useTabInfo, t } = props
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState('')
      const [failure, setFailure] = useState(null)
      /** Images picked for the next question; cleared once the Host accepted it. */
      const [attached, setAttached] = useState([])
      /** A local complaint about the pick itself, kept apart from Host failures. */
      const [notice, setNotice] = useState(null)
      const asking = useRef(false)
      const pendingHandled = useRef(null)
      const scroller = useRef(null)
      const picker = useRef(null)

      let tab
      try {
        tab = useTabInfo().tab
      } catch {
        tab = undefined
      }

      const refresh = useCallback(async () => {
        try {
          const next = await call(`${STATE_PATH}?session=${encodeURIComponent(String(sessionId))}`)
          if (next?.ok === true) {
            setState(next)
            setFailure(null)
          } else if (next?.error !== undefined) {
            setFailure(next.error.message)
          }
        } catch (error) {
          setFailure(error?.message ?? String(error))
        }
      }, [sessionId])

      const ask = useCallback(async (question, images = []) => {
        const text = String(question ?? '').trim()
        if (text === '' || asking.current) return false
        asking.current = true
        setFailure(null)
        setNotice(null)
        setState(previous => (previous === null ? previous : { ...previous, busy: true, pending: null }))
        try {
          const result = await call(ASK_PATH, {
            method: 'POST',
            body: JSON.stringify({
              sessionId: String(sessionId),
              question: text,
              ...(images.length === 0 ? {} : { images }),
            }),
          })
          if (result?.snapshot !== undefined) setState(result.snapshot)
          if (result?.ok === false && result?.error !== undefined) setFailure(result.error.message)
          return result?.ok !== false
        } catch (error) {
          setFailure(error?.message ?? String(error))
          return false
        } finally {
          asking.current = false
          void refresh()
        }
      }, [sessionId, refresh])

      /**
       * Answer one failed row again.
       *
       * The Host still holds the question, so this only names the row; the panel
       * never has to resend text or images.
       */
      const retry = useCallback(async (key) => {
        if (typeof key !== 'string' || key === '' || asking.current) return false
        asking.current = true
        setFailure(null)
        setNotice(null)
        setState(previous => (previous === null ? previous : { ...previous, busy: true }))
        try {
          const result = await call(RETRY_PATH, {
            method: 'POST',
            body: JSON.stringify({ sessionId: String(sessionId), key }),
          })
          if (result?.snapshot !== undefined) setState(result.snapshot)
          if (result?.ok === false && result?.error !== undefined) setFailure(result.error.message)
          return result?.ok !== false
        } catch (error) {
          setFailure(error?.message ?? String(error))
          return false
        } finally {
          asking.current = false
          void refresh()
        }
      }, [sessionId, refresh])

      useEffect(() => {
        setState(null)
        setFailure(null)
        setDraft('')
        setAttached([])
        setNotice(null)
        pendingHandled.current = null
        void refresh()
        const timer = setInterval(() => { void refresh() }, POLL_MS)
        return () => { clearInterval(timer) }
      }, [refresh])

      // A `/btw` typed in the composer queued its question on the Host; answer it here.
      const pending = state?.pending
      const busy = state?.busy === true
      useEffect(() => {
        if (typeof pending !== 'string' || pending === '' || busy || asking.current) return
        if (pendingHandled.current === pending) return
        pendingHandled.current = pending
        void ask(pending)
      }, [pending, busy, ask])

      const count = state?.messages?.length ?? 0
      useEffect(() => {
        const node = scroller.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [count, busy])

      // The Host is the authority on whether images can be stored at all, so the
      // attach control appears only once its answer is known.
      const imageMax = countOf(state?.images?.max)
      const canAttach = state !== null && state?.images?.enabled === true

      const addFiles = useCallback((fileList) => {
        const room = Math.max(0, imageMax - attached.length)
        const picked = pickImages(fileList, room)
        if (picked.refusal !== null) {
          setNotice(t(picked.refusal, { count: imageMax }))
          if (picked.files.length === 0) return
        } else {
          setNotice(null)
        }
        for (const file of picked.files) {
          const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          setAttached(list => [...list, {
            id, name: file.name ?? '', mediaType: file.type, status: 'reading', data: '', dataUrl: '',
          }])
          void readImageFile(file).then((record) => {
            setAttached(list => list.map(item => (item.id === id ? { ...item, ...record, status: 'ready' } : item)))
          }).catch((error) => {
            setNotice(error instanceof Error ? error.message : String(error))
            setAttached(list => list.filter(item => item.id !== id))
          })
        }
      }, [attached.length, imageMax, t])

      const removeImage = useCallback((id) => {
        setAttached(list => list.filter(item => item.id !== id))
        setNotice(null)
      }, [])

      const submit = useCallback(() => {
        const text = draft.trim()
        if (text === '' || asking.current) return
        if (attached.some(item => item.status === 'reading')) {
          setNotice(t('imageReading'))
          return
        }
        const images = imageParts(attached)
        setDraft('')
        void ask(text, images).then((ok) => {
          if (ok) {
            // The Host stores the images it admitted; the draft is consumed.
            setAttached([])
            return
          }
          // A caller mistake (busy thread, refused image batch) recorded nothing,
          // so put the text back rather than making the user retype it.
          setDraft(text)
        })
      }, [draft, attached, ask, t])

      const closeAndForget = useCallback(() => {
        void call(CLOSE_PATH, {
          method: 'POST',
          body: JSON.stringify({ sessionId: String(sessionId) }),
          keepalive: true,
        }).catch(() => {})
        setState(null)
        setFailure(null)
        setAttached([])
        setNotice(null)
        pendingHandled.current = null
        try {
          tab?.actions?.close?.()
        } catch {
          /* the tab may already be gone */
        }
      }, [sessionId, tab])

      if (typeof sessionId !== 'string' || sessionId === '') {
        return h('div', { className: 'btw-root' }, [
          h('style', { key: 'css' }, CSS),
          h('p', { key: 'p', className: 'btw-empty' }, t('unavailable')),
        ])
      }

      const messages = state?.messages ?? []
      const route = state?.route
      const limits = state?.limits

      return h('div', { className: 'btw-root' }, [
        h('style', { key: 'css' }, CSS),
        h('header', { key: 'header', className: 'btw-header' }, [
          h('div', { key: 'titles', className: 'btw-titles' }, [
            h('span', { key: 'title', className: 'btw-title' }, t('header')),
            h('span', { key: 'hint', className: 'btw-hint' }, t('headerHint')),
          ]),
          h('div', { key: 'actions', className: 'btw-actions' }, [
            h('span', {
              key: 'route',
              className: 'btw-route',
              // The chip ellipsizes in a narrow column; the tooltip always carries
              // the whole route so nothing is lost.
              ...(routeTitle(route) === null ? {} : { title: `${t('route')}: ${routeTitle(route)}` }),
            }, routeLabel(route) ?? t('noRoute')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'btw-button btw-button-quiet',
              title: t('closeTitle'),
              onClick: closeAndForget,
            }, t('close')),
          ]),
        ]),

        h('div', { key: 'scroll', className: 'btw-scroll', ref: scroller }, [
          state === null
            ? h('p', { key: 'loading', className: 'btw-empty' }, '…')
            : messages.length === 0
              ? h('p', { key: 'empty', className: 'btw-empty' }, t('empty'))
              : h('div', { key: 'list', className: 'btw-list' },
                messages.map(message => h(Exchange, {
                  key: message.key, message, t, sessionId, onRetry: retry,
                }))),
          busy ? h('div', { key: 'busy', className: 'btw-busy' }, [
            h('span', { key: 'dot', className: 'btw-dot' }),
            h('span', { key: 'text' }, t('sending')),
          ]) : null,
          failure === null ? null : h('div', { key: 'error', className: 'btw-error' }, [
            h('strong', { key: 'k' }, `${t('failed')}: `),
            h('span', { key: 'v' }, String(failure)),
          ]),
        ]),

        h('div', { key: 'foot', className: 'btw-foot' }, [
          h(UsageStrip, { key: 'usage', totals: state?.totals, t, tools: state?.tools }),
          h('p', { key: 'note', className: 'btw-note' }, t('notKept')),
          h('form', {
            key: 'composer',
            className: 'btw-composer',
            onSubmit: (event) => { event.preventDefault(); submit() },
            onDragOver: (event) => {
              // Keep a drop aimed at this panel away from the conversation's own
              // file intake behind it.
              event.preventDefault()
              event.stopPropagation()
            },
            onDrop: (event) => {
              event.preventDefault()
              event.stopPropagation()
              if (!canAttach) {
                setNotice(t('imagesOff'))
                return
              }
              addFiles(event.dataTransfer?.files)
            },
          }, [
            attached.length === 0 ? null : h('div', { key: 'pending', className: 'btw-pending' },
              attached.map(item => h('div', { key: item.id, className: 'btw-chip' }, [
                item.dataUrl === ''
                  ? h('span', { key: 'ph', className: 'btw-chip-img btw-chip-blank' })
                  : h('img', { key: 'img', className: 'btw-chip-img', src: item.dataUrl, alt: item.name }),
                h('button', {
                  key: 'remove',
                  type: 'button',
                  className: 'btw-chip-x',
                  title: t('imageRemove'),
                  'aria-label': t('imageRemove'),
                  onClick: () => { removeImage(item.id) },
                }, '×'),
              ]))),
            notice === null ? null : h('p', { key: 'notice', className: 'btw-notice' }, notice),
            h('div', { key: 'row', className: 'btw-composer-row' }, [
              canAttach
                ? h('button', {
                  key: 'attach',
                  type: 'button',
                  className: 'btw-attach',
                  title: t('attachHint'),
                  'aria-label': t('attach'),
                  disabled: busy,
                  onClick: () => {
                    const input = picker.current
                    if (typeof input?.click === 'function') input.click()
                  },
                }, h(ClipIcon))
                : null,
              h('input', {
                key: 'file',
                type: 'file',
                accept: IMAGE_TYPES.join(','),
                multiple: true,
                style: { display: 'none' },
                ref: picker,
                onChange: (event) => {
                  const files = event.target.files
                  try {
                    event.target.value = ''
                  } catch {
                    /* a frozen event target still lets the read start */
                  }
                  addFiles(files)
                },
              }),
              h('textarea', {
                key: 'input',
                className: 'btw-input',
                value: draft,
                rows: 2,
                placeholder: t('placeholder'),
                disabled: busy,
                onChange: (event) => { setDraft(event.target.value) },
                onPaste: (event) => {
                  const files = event.clipboardData?.files
                  if (files === undefined || files === null || files.length === 0) return
                  event.preventDefault()
                  if (!canAttach) {
                    setNotice(t('imagesOff'))
                    return
                  }
                  addFiles(files)
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit()
                  }
                },
              }),
              h('button', {
                key: 'send',
                type: 'submit',
                className: 'btw-button btw-button-primary',
                disabled: busy || draft.trim() === '',
              }, t('send')),
            ]),
          ]),
          limits === undefined || limits === null ? null : h('p', {
            key: 'limits',
            className: 'btw-limits',
            title: limitsHint(limits, t),
          }, limitsLine(limits, t)),
        ]),
      ])
    }

    /** Navigation controller for the on-screen session, captured at activation. */
    let navigationRef = null

    /**
     * Command ids whose automatic open already ran.
     *
     * A transcript row is a record, not a command: the chat unmounts and
     * remounts rows whenever its session is shown again, so an unguarded open
     * would pull the right column open on every visit to that session.
     */
    const autoOpened = new Set()

    /** Only a command that just ran may move the shell's layout. */
    const AUTO_OPEN_WINDOW_MS = 30_000

    /**
     * Reveal the panel, which expands the right column.
     *
     * Skipped while the panel is already the active tab, because revealing it
     * again would re-assert the column layout for no reason.
     */
    function revealPanel() {
      try {
        if (navigationRef?.active?.()?.kind === KIND) return
        navigationRef?.openTab?.(KIND)
      } catch {
        /* the tab type is not registered yet; the guide still opens it */
      }
    }

    /** The `/btw` command row: a record of the run, plus a way back into the panel. */
    function BtwCommandRow({ node, t }) {
      const commandId = typeof node?.commandId === 'string'
        ? node.commandId
        : typeof node?.seq === 'number' ? `seq:${node.seq}` : undefined
      const justRan = typeof node?.time === 'number'
        && Date.now() - node.time <= AUTO_OPEN_WINDOW_MS
      useEffect(() => {
        if (commandId === undefined || autoOpened.has(commandId)) return
        autoOpened.add(commandId)
        if (!justRan) return
        revealPanel()
      }, [commandId, justRan])
      return h('div', { className: 'btw-command' }, [
        h('style', { key: 'css' }, CSS),
        h('span', { key: 'dot', className: 'btw-command-dot' }),
        h('span', { key: 'text', className: 'btw-command-text' }, t('commandOpened')),
        h('button', {
          key: 'open',
          type: 'button',
          className: 'btw-command-open',
          onClick: revealPanel,
        }, t('openPanel')),
      ])
    }

    /**
     * Panel styling.
     *
     * Chrome (header, usage, composer) uses the alias colour tokens. The answer
     * body repeats the conversation's own markdown rules — same margins, list
     * indents, table paddings, and code-block chrome — under the `btw-md`
     * prefix. The `--dsw-font-markdown-*` shorthand tokens are referenced
     * without a fallback on purpose: this build does not define them, so the
     * shipped assistant body falls back the same way, and the two stay equal.
     */
    const CSS = `
.btw-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size, 14px);line-height:calc(24px + var(--dsh-content-font-delta, 0px))}
.btw-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}
.btw-titles{display:flex;flex-direction:column;min-width:7rem;flex:1 1 auto}
.btw-title{font-weight:600;font-size:13px;line-height:20px}
.btw-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.btw-actions{display:flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0}
.btw-actions .btw-button{flex:0 0 auto}
/* Grows with the column and ellipsizes only when it genuinely cannot fit; the
   fixed 120px cap clipped a one-line model id even on a wide panel. */
.btw-route{flex:0 1 auto;min-width:0;max-width:14rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px}
.btw-button{font:inherit;font-size:12px;line-height:18px;border-radius:8px;padding:4px 10px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.btw-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.btw-button:disabled{opacity:.45;cursor:default}
.btw-button-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.btw-button-quiet{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.btw-button-quiet:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:transparent}
.btw-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:16px}
.btw-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;margin:0}
.btw-list{display:flex;flex-direction:column;gap:16px}
.btw-exchange{display:flex;flex-direction:column;gap:4px;max-width:100%;min-width:0}
.btw-question{align-items:flex-end}
.btw-question-body{align-self:flex-end;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px 10px;max-width:88%;white-space:pre-wrap;word-break:break-word}
.btw-exchange-meta{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;font-variant-numeric:tabular-nums}
.btw-exchange-footer{display:flex;align-items:center;gap:8px;min-height:16px}
.btw-copy{border:none;background:transparent;padding:0 2px;font:inherit;font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm)}
.btw-copy:hover{color:var(--dsw-alias-label-primary)}
.btw-warn{color:var(--dsw-alias-state-warn-primary);font-size:10.5px;line-height:16px}
.btw-empty-answer{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:20px}
.btw-failure{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btw-retry{font:inherit;font-size:11px;line-height:18px;padding:2px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.btw-retry:hover{background:var(--dsw-alias-bg-layer-2)}
.btw-retry:disabled{opacity:.45;cursor:default}
.btw-busy{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.btw-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:btw-pulse 1.1s ease-in-out infinite}
@keyframes btw-pulse{0%,100%{opacity:.3}50%{opacity:1}}
.btw-error{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap;word-break:break-word}
.btw-foot{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px 10px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}
.btw-usage{display:flex;flex-direction:column;gap:8px}
.btw-pills{display:flex;align-items:center;gap:2px;min-width:0;margin:0;padding:0;border:none;background:transparent;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm);text-align:left}
.btw-pills:hover,.btw-pills[aria-expanded="true"]{color:var(--dsw-alias-label-secondary)}
.btw-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border-radius:var(--dsw-radius-sm);font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px));font-variant-numeric:tabular-nums;white-space:nowrap;transition:background-color .12s ease}
.btw-pills:hover .btw-pill,.btw-pills[aria-expanded="true"] .btw-pill{background:var(--dsw-alias-interactive-bg-hover)}
.btw-pill svg{width:14px;height:14px;flex:none}
.btw-pill-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.btw-sep{margin:0 6px;opacity:.6}
.btw-chevron{display:inline-flex;align-items:center;justify-content:center;margin-left:2px;padding:0 4px;opacity:.7;transition:transform .15s ease}
.btw-chevron[data-open]{transform:rotate(180deg)}
.btw-details{display:grid;grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.btw-details dt,.btw-details dd{min-width:0;margin:0}
.btw-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.btw-note{color:var(--dsw-alias-state-idle-primary);font-size:10.5px;line-height:16px;margin:0}
.btw-composer{display:flex;flex-direction:column;gap:6px}
.btw-composer-row{display:flex;align-items:flex-end;gap:6px}
.btw-attach{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:26px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.btw-attach:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.btw-attach:disabled{opacity:.45;cursor:default}
.btw-attach svg{width:16px;height:16px}
.btw-pending{display:flex;flex-wrap:wrap;gap:8px;padding:2px 0}
.btw-chip{position:relative;display:inline-flex}
.btw-chip-img{width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.btw-chip-blank{display:inline-block;animation:btw-pulse 1.1s ease-in-out infinite}
.btw-chip-x{position:absolute;top:-5px;right:-5px;width:16px;height:16px;padding:0;line-height:14px;text-align:center;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.btw-chip-x:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.btw-notice{color:var(--dsw-alias-state-warn-primary);font-size:10.5px;line-height:16px;margin:0}
.btw-question-body-media{padding:8px}
.btw-question-images{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}
.btw-question-image{max-width:132px;max-height:96px;object-fit:cover;border-radius:6px;border:1px solid var(--dsw-alias-border-l1)}
.btw-question-text{display:block;white-space:pre-wrap;word-break:break-word}
.btw-input{flex:1 1 auto;min-width:0;resize:none;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;outline:none}
.btw-input:focus{border-color:var(--dsw-alias-brand-primary)}
.btw-limits{color:var(--dsw-alias-state-idle-primary);font-size:10px;margin:0;font-variant-numeric:tabular-nums}
.btw-command{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
.btw-command-dot{width:6px;height:6px;border-radius:50%;border:1px solid var(--dsw-alias-brand-primary);background:transparent}
.btw-command-open{margin-left:2px;padding:0 2px;border:none;background:transparent;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-brand-primary);cursor:pointer;border-radius:var(--dsw-radius-sm)}
.btw-command-open:hover{text-decoration:underline}

/* ---- answer body: the conversation's markdown rules, under btw-md ---- */
.btw-md{min-width:0;overflow-wrap:anywhere;font:var(--dsw-font-markdown-base);color:var(--dsw-alias-label-primary)}
.btw-md strong{font-weight:600}
.btw-md h1{font:var(--dsw-font-markdown-h1);margin:32px 0 16px}
.btw-md h2{font:var(--dsw-font-markdown-h2);margin:32px 0 16px}
.btw-md h3{font:var(--dsw-font-markdown-h3);margin:32px 0 16px}
.btw-md h4{font:var(--dsw-font-markdown-h4);margin:16px 0}
.btw-md :where(h5,h6){font:var(--dsw-font-markdown-base-strong);margin:16px 0}
.btw-md :where(h1,h2,h3,h4,h5,h6) strong{font-weight:inherit}
.btw-md p{margin:16px 0}
.btw-md :where(h4,h5,h6)+:where(ul,ol){margin-top:8px}
.btw-md :where(h4,h5,h6):has(+:where(ul,ol)){margin-bottom:8px}
.btw-md a{color:var(--dsw-alias-link);font-weight:500;text-decoration:none;position:relative}
.btw-md a:hover{text-decoration:underline}
.btw-md a:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));border-radius:3px}
.btw-md :where(ul,ol){margin:16px 0;padding-left:18px}
.btw-md li:not(:first-child){margin-top:6px}
.btw-md li>:where(ul,ol){margin-top:4px}
.btw-md li::marker{line-height:24px;color:var(--dsw-alias-label-secondary)}
.btw-md :where(ul,ol) ol{list-style-position:inside;padding-left:0}
.btw-md :where(ul,ol) ol li p{display:inline}
.btw-md li>p{margin:8px 0}
.btw-md li>*:first-child{margin-top:0}
.btw-md li>*:last-child:not(.btw-md-code){margin-bottom:0}
.btw-md li.btw-md-task{list-style:none;margin-left:-18px;display:flex;align-items:flex-start;gap:8px}
.btw-md li.btw-md-task input[type=checkbox]{margin:0;accent-color:var(--dsw-alias-label-secondary);flex:none;position:relative;top:5px}
.btw-md li.btw-md-task>span{min-width:0}
.btw-md hr{display:block;border:none;height:.5px;margin:32px 0;background:var(--dsw-alias-border-l2)}
.btw-md blockquote{border-left:2px solid var(--dsw-alias-label-caption);margin:16px 0 0;padding-left:14px;color:var(--dsw-alias-label-primary)}
.btw-md pre{margin:0;font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);overflow:auto}
.btw-md :not(pre)>code{display:inline-flex;align-items:center;box-sizing:border-box;font:var(--dsw-font-markdown-code);font-size:.875em;background-color:var(--dsw-alias-markdown-inline-code);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm, 8px);padding:0 5px}
.btw-md :where(h1,h2,h3,h4,h5,h6) code{font:inherit;font-family:var(--ds-font-family-code, ui-monospace, monospace)}
.btw-md>*:first-child{margin-top:0!important}
.btw-md>*:last-child{margin-bottom:0!important}
.btw-md-code{margin:16px 0;border-radius:var(--dsl-code-block-border-radius, var(--dsw-radius-lg, 10px));background:var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2));overflow:hidden}
.btw-md-banner{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;font:var(--dsl-code-block-banner-font, 11px/18px var(--dsw-font-family, inherit));color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-markdown-code-block-banner, transparent);border-top-left-radius:var(--dsl-code-block-border-radius, var(--dsw-radius-lg, 10px));border-top-right-radius:var(--dsl-code-block-border-radius, var(--dsw-radius-lg, 10px))}
.btw-md-lang{text-transform:lowercase;letter-spacing:.02em}
.btw-md-copy{background:transparent;border:none;padding:0;margin:0;color:inherit;cursor:pointer;font:inherit}
.btw-md-copy:hover{color:var(--dsw-alias-label-primary)}
.btw-md-pre{padding:12px 14px}
.btw-md-pre code{font:var(--dsw-font-markdown-code);white-space:pre;color:var(--dsw-alias-label-primary)}
.btw-tok-com{color:var(--dsw-alias-label-secondary);font-style:italic}
.btw-tok-str{color:var(--dsw-alias-state-success-primary)}
.btw-tok-num{color:var(--dsw-alias-state-warn-primary)}
.btw-tok-kw{color:var(--dsw-alias-brand-primary)}
.btw-md-tablescroll{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;margin:16px 0}
.btw-md-tablescroll table{border-collapse:collapse;width:max-content;max-width:max-content;font-size:inherit}
.btw-md-tablescroll th{text-align:start;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2));font:var(--dsw-font-markdown-table-head);font-weight:600;min-width:100px;max-width:min(30vw,320px)}
.btw-md-tablescroll td{padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);font:var(--dsw-font-markdown-table);min-width:100px;max-width:min(30vw,320px)}
.btw-md-tablescroll th:first-child,.btw-md-tablescroll td:first-child{padding-left:0}
.btw-md-tablescroll td:last-child{padding-right:0}
.btw-md-tablescroll table code{font-size:11px}
`

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      /**
       * Exposed for the offline test (`tests/verify.mjs`). The module loader
       * reads only `inject` and `apply`, so this key is inert at runtime.
       */
      internal: {
        parseBlocks, renderInline, renderMarkdown, splitRow, highlight, usageSummary, UsageStrip, Exchange,
        BtwCommandRow, imageUrl, imageParts, pickImages, limitsLine, limitsHint, readImageFile,
        routeLabel, routeTitle,
      },
      apply(ctx) {
        navigationRef = ctx.sidebarRight

        ctx.effect(() => {
          // The per-locale form is the documented path for a bundle outside the
          // built-in namespace table.
          const disposeEn = ctx.locale.register(NS, 'en', EN)
          const disposeZh = ctx.locale.register(NS, 'zh', ZH)
          return () => {
            disposeZh()
            disposeEn()
          }
        }, 'btw: copy')
        // Live chip text: the thunks are re-read whenever the guide draws them.
        const t = ctx.locale.bind(NS)

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          title: () => t('tabTitle'),
          guide: [{
            id: 'btw',
            order: 20,
            title: () => t('guideTitle'),
            description: () => t('guideDescription'),
          }],
        }), 'btw: tab type')

        // Closing the tab drops the Host thread; nothing about it survives.
        ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (closedSessionId) => {
          void call(CLOSE_PATH, {
            method: 'POST',
            body: JSON.stringify({ sessionId: String(closedSessionId) }),
            keepalive: true,
          }).catch(() => {})
        }), 'btw: close handler')

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, BtwBody)), 'btw: panel body')

        ctx.effect(() => ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: KIND,
          locale: NS,
        }, BtwCommandRow)), 'btw: command row')
      },
    }
  },
})
