# Btw side session

English | [中文](README.zh-CN.md)

[![test](https://github.com/1bigmouse/dsh-btw-session/actions/workflows/test.yml/badge.svg)](https://github.com/1bigmouse/dsh-btw-session/actions/workflows/test.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Answers quick side questions **in the right sidebar** from the current
conversation, keeps them out of that conversation's context, reports the side
thread's token usage separately, and retains nothing once you close it. It can
look at screenshots — the ones already in the conversation and ones you attach —
and read workspace files on request.

A third-party bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It is not part of DSH itself, and it adds nothing to the conversation it is
asked from.

## Install

**Compatibility:** built and tested on **DSH 0.2.2-rc.5** (Desktop and CLI).
Older releases are untested and may lack the right-sidebar tab slots this bundle
registers, or the attachment and scoped-tool APIs its images and lookups use.

Install straight from GitHub:

```sh
dsh plugin --profile <profile> add github:1bigmouse/dsh-btw-session
```

`<profile>` is the name of the DSH profile you launch: `desktop` for the Desktop
app, or the name after `dsh --profile` for the CLI. In Desktop you can instead
paste the same address into **Plugins → Add plugin** and skip the command line.

To pin the exact source you reviewed, append the commit:

```sh
dsh plugin --profile <profile> add github:1bigmouse/dsh-btw-session#<sha>
```

Or clone it and install the checkout as a local directory — in Desktop,
**Plugins → Add plugin** accepts the cloned directory too:

```sh
git clone https://github.com/1bigmouse/dsh-btw-session
dsh plugin --profile <profile> add ./dsh-btw-session
```

The package ships plain ESM JavaScript, so there is no build step and no pnpm
`allowBuilds` approval is involved.

## Use it

1. Open **Btw** from the right sidebar's guide, or type `/btw <question>` in the
   composer. Either way the panel opens on the right.
2. Ask follow-ups in the panel's own composer. Each answer uses the current
   session as read-only context plus the panel's earlier exchanges, and may look
   up workspace files. Every answer carries a copy control in its footer.
3. Attach a screenshot with the paperclip, by pasting into the box, or by
   dropping it on the panel. Screenshots the conversation already contains are
   forwarded automatically, so "what is wrong in this screenshot?" also works for
   an image sent before the panel was opened.
4. The usage row under the conversation counts only this side thread — questions and
   decode speed, then tokens and cache hit. Press it to open the full breakdown.
5. A row that produced no answer says why and offers **Retry**, which re-asks the
   same question — no need to retype or reattach anything.
6. Press **Close and forget** (or close the tab) to drop the thread. The panel's
   next open starts empty.

The one line under the composer is the request budget, not a progress meter:
`replay ≤20 turns · context ≤80 msgs` means each answer is assembled from the
panel's last 20 questions and answers plus the most recent 80 messages of the
conversation. Hovering it names the character ceiling too; the oldest messages
drop off first.

## What it does not do

- It adds no message, turn, tool call, or assistant message to the session it
  was opened from. Nothing from the side thread becomes model context there, and
  a lookup it runs writes no `tool/call` or `tool/result` event to that session.
- It can only **read**. `read`, `glob`, and `grep` run with the same sandbox and
  the same working directory as the session, but nothing on the whitelist can
  write, edit, patch, or run a command. Set `tools: []` to answer from the
  conversation alone.
- It has no subagents, no approvals workflow, and no web access.
- It accepts **images only** as attachments. PDFs, source files, and anything
  else the conversation's composer would upload as a file are refused, because a
  side request can only hand the model a raster it can look at.
- It does not persist. The thread lives in the Host process's memory for that
  session only; closing the panel, reloading, or restarting the Host discards it.
  Image *bytes* are the exception described under "Security and privacy": they
  are stored by DSH's own attachment store, which this bundle cannot delete from.
- The `/btw` command itself is still recorded in the session log as a command
  run, because that is what running any command does. The question and the
  answer are not part of that record.

## Security and privacy

- **No telemetry, no service of its own.** Every answer is one `ctx.llm.stream`
  call through the session's configured route. The bundle contacts nothing else,
  reads no environment variables or credential stores, and sends nothing to the
  author.
- **No storage.** The side thread lives in the Host process memory, keyed by the
  parent session id, and is dropped on close, panel reload, or Host restart. No
  file, database row, or session event records a question or an answer.
- **Read-only lookups.** Only `read`, `glob`, and `grep` can run, and only when
  the parent session's own last request offered them; `maxToolRounds` bounds the
  loop, and a call outside the whitelist never executes.
- **Framework-gated routes.** The panel talks over DSH's authenticated `/api`
  bridge: requests carry the browser's DSH session cookie and pass the
  framework's host and origin checks before a handler runs. The bundle adds no
  tokens, no cookies, no CORS headers, and no origin logic of its own. Those
  routes are scoped to one owner-controlled profile, so a page already trusted
  by that profile can address any of its session ids — the trust boundary is the
  profile, not the panel.
- **Answers cannot become code.** Markdown is rendered as React elements, raw
  HTML is never interpreted, and link and image destinations are limited to
  `http:`, `https:`, and `mailto:`.
- **Images are stored, but the thread is not.** An image you attach is written to
  DSH's content-addressed attachment store through
  `ctx.attachments.admitPromptContent` — the same admission gate a normal prompt
  passes, with the same count, byte, pixel, and format limits — because that is
  the only way a durable `ImageBlock` can reach a model. Closing the panel drops
  the thread and every reference in it, but the stored image bytes stay in that
  store: this bundle has no delete API and does not invent one. Treat an attached
  screenshot as retained on disk, exactly as you would one sent in a normal
  message.
- **The image route is thread-scoped.** `GET /api/btw/image` serves bytes only for
  attachment ids the asking session's own thread admitted; it cannot be pointed at
  another session's stored objects.

## Configuration

The Host row in `cordis.patch.yml` accepts:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxExchanges` | `20` | Earlier exchanges of the side thread replayed with a new question |
| `maxContextMessages` | `80` | Parent-conversation messages included in one side request |
| `maxContextChars` | `48000` | Character budget for that parent context, oldest dropped first |
| `maxContextImages` | `3` | Screenshots from the parent conversation forwarded for the model to look at |
| `maxImages` | `6` | Images one side question may attach; `0` turns image input off |
| `maxRequestImages` | `8` | Image occurrences kept in one whole request, newest first |
| `maxOutputTokens` | `8192` | Output cap for one side answer; reasoning tokens count against it |
| `tools` | `["read","glob","grep"]` | Read-only tools a side answer may call; `[]` answers from context only |
| `maxToolRounds` | `4` | Tool rounds allowed before one final answer pass that runs without tools |
| `timeoutMs` | `300000` | Wall-clock budget for one answer; `0` disables the timer |
| `route` | `null` | Fixed `{ provider, model }`; by default the session's own route |
| `systemPrompt` | `null` | Replacement for the side-question system prompt |

## How it works

The Host half registers a `/btw` command and a small service that snapshots the
parent conversation's content, sends it plus the side thread to
`ctx.llm.stream`, and folds the provider's usage report into the panel's
counters. The browser half registers a right-sidebar tab type and talks to the
Host over five authenticated routes: `POST /api/btw/ask`, `POST /api/btw/retry`,
`GET /api/btw/state`, `POST /api/btw/close`, and `GET /api/btw/image`.

### Only settled context

The parent snapshot is cut at the first tool call that never received a result.
A turn that is still running has an assistant message whose calls have no
answers yet, and replaying that prefix would hand the model a conversation that
stops in the middle of an action. This is the same boundary OpenCode's
`SessionHistory.preview` draws; queued-but-undelivered input is invisible for
the same reason — it is not part of the conversation yet.

### Failures are rows, not silence

Every attempt after the model was called ends up in the thread: either an answer,
or a failed row carrying why it failed — `timeout` (the `timeoutMs` budget),
`interrupted` (cancelled or the panel closed), or `error` (the provider failed) —
plus a **Retry** control. An empty answer is retryable for the same reason. Retry
is Host-side and names only the failed row: the question, including its images, is
already recorded, so nothing has to be resent and no second question row appears.
Successful rows are not retryable.

Each attempt carries a monotone attempt number. A result that arrives after the
panel was closed, or after a newer attempt took over, is discarded instead of
rewriting the rows — the same stale guard the OpenCode desktop state machine
uses. Usage is counted even for a failed attempt: those tokens were billed.

### Images

An attached image travels as canonical base64 in the ask body and is stored
Host-side by `ctx.attachments.admitPromptContent`, the same gate an ordinary
prompt uses. The service verifies the declared media type against the decoded
bytes and applies the deployment's own image limits, so the side thread cannot
store more than a normal message may. The stored reference then becomes a
`{ type: 'image', attachment }` content block, which is the only image shape the
LLM service accepts.

The same reference is what the panel draws: `GET /api/btw/image` re-reads and
re-verifies the stored object and returns its bytes, so a reloaded panel still
shows the picture a question was about instead of an empty box.

Screenshots already in the conversation are forwarded by reference rather than
flattened to `[image attachment]`, because the picture is usually the subject of
the question. That forwarding is bounded twice: `maxContextImages` for the
context window and `maxRequestImages` for the whole request. When the request cap
drops an occurrence, a short note stays in its place so the model can tell an
image was omitted rather than never sent. The panel's usage breakdown reports the
images actually sent.

A model route that accepts text only is not an error: the LLM layer turns each
image into a stable text placeholder for that route.

### Why a direct model call, not a second Agent

A second Agent would own a real Session, and a Session is written to the
durable log: the dialogue would survive the panel, and its request would be
reconstructed on resume. That contradicts "keep nothing after closing". The side
thread therefore lives in the Host process's memory only, keyed by the parent
session id, and is deleted on close or panel reload. The parent session never
receives an inbox message, a turn, a tool call, or an assistant message from it.

The side request is a plain conversation: parent instruction messages are
dropped, tool-call blocks from the parent's history are stripped, and the
parent's tool results are folded into text so the new request starts from one
consistent, tool-free transcript. Only the settled prefix of that history is
used — a turn still in flight is not a conversation yet. Image blocks keep their
durable reference instead of a placeholder. The only tools offered are the
read-only whitelist for the side thread's own lookups.

### Read-only tools without polluting the transcript

A side answer may call `read`, `glob`, and `grep` through `ctx.tools.execute`
with the batch `log` field omitted: the same tool body runs against the same
sandbox and working directory, but no `tool/call` or `tool/result` event reaches
the parent session. The loop is bounded by `maxToolRounds`, and any call outside
the whitelist never executes — the model receives an error result instead.

The whitelist is resolved with the **agent as the lookup scope**:
`ctx.tools.executable(name, agent)`, falling back to `ctx.tools.get(name, agent)`.
`ctx.tools` keeps one layered view per scope — `ScopeKey` is an
identity-compared object, and the Agent is that key — so a scope-less
`ctx.tools.get(name)` reads the *global* view, which is not the set a session may
call. That lookup returns nothing for these tools, which is how side requests once
went out with no tools at all while the panel still reported "Tools: off". The
same lookup already applies the session's own admission, so no separate guess at
the preset's restrictions is layered on top.

Schemas are read one definition at a time rather than through
`ctx.tools.schemas()`. The bulk call projects the whole registry and throws when
any single tool's parameters cannot be detached; one such tool would otherwise
leave the side request with no tools — while the system prompt still promised
them, which is exactly what makes a model write the call out as markup instead.

The panel names the reason when the list is empty: empty whitelist, no tool
service, not granted to this session, or a schema that cannot be serialized.

The budget is spent per question, and a model can spend all of it reading. When
the last allowed round still asks for lookups, those calls are **not executed**
(nothing may be appended to a request whose result will never arrive) and one
**closing pass runs without tools**, with a prompt that says the budget is spent
and asks for an answer from what was already read. That is why the answer row can
report more rounds than `maxToolRounds`: one of them exists only to stop the
model from reading forever. An answer produced this way is marked
"read budget hit", so a thinner answer is visible as such instead of looking like
the model's best effort.

If a provider returns the call as prose anyway, the markup is dropped before the
answer reaches the panel and the answer footer marks the answer as
"tool call came back as text". The detector normalizes the separators a model
invents — box-drawing bars, full-width bars, zero-width joiners inside the token,
full-width letters — because matching only the ASCII pipe once let an entire call
render as the answer. When nothing but markup came back the row is empty, which
the panel states and offers **Retry**; it never shows the raw tags.

### A silent panel is never an outcome

A completed ask is recorded even when the model produced no visible prose, and
the answer row states why: the tool rounds ran out and the closing pass had
nothing to say either, the output cap was reached before any text, the model only
wrote a tool call as markup, the provider failed, or the request timed out or was
cancelled. Before this, an empty answer recorded nothing at all, so a broken
answer and a broken panel looked identical.

Every one of those rows is retryable, so the reason is never the end of the
question. Only a caller mistake the Host refused before calling the model — an
empty question, an image batch over the limit, an answer already running — keeps
the composer's text, because nothing was recorded to retry.

The default output cap is 8192 tokens because reasoning counts against it on
routes that bill reasoning as output; a smaller cap can be consumed entirely
before the first visible token.

### Rendering

An answer is drawn with a Markdown renderer whose rules are copied from the
conversation's own assistant body — the same `--dsw-font-markdown-*` ladder,
margins, list indents, table paddings, and code-block chrome from the theme's
`design-platform.css` and `gradient-shadow-text.css`. Harness Client packages
are not imported as modules, so the structure is reproduced locally under the
`btw-md` prefix and styled with the same design tokens.

Supported: ATX headings, thematic breaks, block quotes, nested ordered and
unordered lists, task lists, GFM tables with alignment, fenced code blocks with
a language banner and copy control, and inline code, emphasis, strikethrough,
links, autolinks, and hard line breaks. Raw HTML is never interpreted.

Syntax colouring is a small scanner for comments, strings, numbers, and
keywords, not a Shiki grammar: snippets in an unknown language render in one
colour.

### Usage strip

The counters are shaped like the conversation's own composer statistics pills:
collapsed, one row of icon + reading segments — `2 asks · 500 tok/s` and
`36k tok · cache hit 48.5%` — with a chevron. Pressing the row opens a
description list in the same skin the session-statistics dialog uses.

Prompt-side accounting follows the main strip's definition so the numbers are
comparable: the billed input is `uncached input + cache read + cache write`,
the total adds output, and the cache-hit share is read against that billed
input. A partial hit never reports 100%, and a bucket that stayed at zero
(cache write, reasoning) drops its row instead of showing an empty figure.
Decode speed excludes first-token waiting.

## Where this differs from `/btw` elsewhere

| Surface | Tools | What survives | Follow-ups |
| --- | --- | --- | --- |
| Claude Code `/btw` | none — "answer only from what is already in context" | memory, lost on exit | terminal: one answer; VS Code: a capped thread |
| Copilot CLI `/ask` (alias `/btw`) | none | not kept | one answer |
| Codex `/side` | inherits the chat's tools (an ephemeral chat fork) | a separate transcript | yes — it is a chat |
| OpenCode TUI `/btw` | every session tool is exposed, but there is **no tool loop** — the prompt tells the model not to call them | nothing is written to the conversation, not even a message, while tokens and cost still count toward the session's totals | a dialog, one answer, copied with `C`, no persistence |
| this plugin | read-only `read`/`glob`/`grep` with a bounded loop | Host memory, dropped on close; the panel counts its own tokens and leaves the session's totals alone | yes, in the panel |

Only this plugin looks at pictures: it forwards screenshots the conversation
already contains and accepts new ones in the panel. The others are text-only.
Only this plugin can be asked a follow-up, and only this plugin reports the side
thread's usage separately — OpenCode folds side-question cost into the session
total and has no per-side-thread figure.

What this plugin took from OpenCode is the failure semantics rather than the
shape: settled-only context, a wall-clock budget, retryable failed rows, and the
stale-result guard. The OpenCode TUI has none of those yet — its own state
machine lives in the desktop client, where each question gets a tab and a 300 s
timeout.

Two things come straight from the OpenCode TUI: the running state stays visible
outside the answer surface (there it is a `/btw` marker in the prompt footer;
here it is the busy row and the panel's own footer), and the answer can be copied
whole — there with `C`, here with a copy control in the answer footer.

### The `/btw` row never moves the layout on its own

The command row is a record of a run, like the shipped `/team` row, so it does
not drive the shell. It opens the panel **only for a command that just ran**
(within 30 s of its recorded time) and **only once per command id**: the chat
unmounts and remounts rows whenever a session is shown again, and an unguarded
open would expand the right column on every visit to any session that ever ran
`/btw`. A row from an earlier visit keeps a small **Open panel** control so the
panel is still one click away.

Revealing is also skipped while the panel is already the active tab, because
opening it again re-asserts the column layout for no reason.

If a session still shows the column expanded after an upgrade, that is the right
sidebar restoring the layout it saved for that session — collapse it once and the
choice is remembered for that session.

## Verify

```sh
npm test          # or: node tests/verify.mjs
```

The test loads both halves against stub Cordis contexts and checks the command,
the five routes, the request assembly, image admission and the request-level
image cap, the settled-context boundary, the timeout and retryable-failure paths,
the metrics fold, and every client registration (tab type, guide entry, panel
body, command row, close handler).
No network access and no DSH installation are needed, so the same command runs
in GitHub Actions on Node 22 and 24.

## Community

Announced and discussed in DeepSeek Harness Discussions:
https://github.com/deepseek-ai/deepseek-harness/discussions/13685

## License

[MIT](./LICENSE) © 2026 1bigmouse

