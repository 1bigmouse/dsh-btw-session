# Btw side session

English | [中文](README.zh-CN.md)

[![test](https://github.com/1bigmouse/dsh-btw-session/actions/workflows/test.yml/badge.svg)](https://github.com/1bigmouse/dsh-btw-session/actions/workflows/test.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Answers quick side questions **in the right sidebar** from the current
conversation, keeps them out of that conversation's context, reports the side
thread's token usage separately, and retains nothing once you close it.

A third-party bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It is not part of DSH itself, and it adds nothing to the conversation it is
asked from.

## Install

```sh
dsh plugin --profile <profile> add github:1bigmouse/dsh-btw-session
```

Or keep a checkout and link it:

```sh
git clone https://github.com/1bigmouse/dsh-btw-session
dsh plugin --profile <profile> add ./dsh-btw-session
```

The package ships plain ESM JavaScript, so there is no build step and no pnpm
`allowBuilds` entry to approve. Pin a commit
(`github:1bigmouse/dsh-btw-session#<sha>`) when you want the exact source you
reviewed. In Desktop, **Plugins → Add plugin** accepts the same checkout
directory.

Developed and tested against **DSH 0.2.2-rc.3** (Desktop and CLI). Older
releases may not provide the right-sidebar tab slots this bundle registers.

## Use it

1. Open **Btw** from the right sidebar's guide, or type `/btw <question>` in the
   composer. Either way the panel opens on the right.
2. Ask follow-ups in the panel's own composer. Each answer uses the current
   session as read-only context plus the panel's earlier exchanges, and may look
   up workspace files. Every answer carries a copy control in its footer.
3. The usage row under the conversation counts only this side thread — questions and
   decode speed, then tokens and cache hit. Press it to open the full breakdown.
4. Press **Close and forget** (or close the tab) to drop the thread. The panel's
   next open starts empty.

## What it does not do

- It adds no message, turn, tool call, or assistant message to the session it
  was opened from. Nothing from the side thread becomes model context there, and
  a lookup it runs writes no `tool/call` or `tool/result` event to that session.
- It can only **read**. `read`, `glob`, and `grep` run with the same sandbox and
  the same working directory as the session, but nothing on the whitelist can
  write, edit, patch, or run a command. Set `tools: []` to answer from the
  conversation alone.
- It has no subagents, no approvals workflow, and no web access.
- It does not persist. The thread lives in the Host process's memory for that
  session only; closing the panel, reloading, or restarting the Host discards it.
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

## Configuration

The Host row in `cordis.patch.yml` accepts:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxExchanges` | `20` | Earlier exchanges of the side thread replayed with a new question |
| `maxContextMessages` | `80` | Parent-conversation messages included in one side request |
| `maxContextChars` | `48000` | Character budget for that parent context, oldest dropped first |
| `maxOutputTokens` | `8192` | Output cap for one side answer; reasoning tokens count against it |
| `tools` | `["read","glob","grep"]` | Read-only tools a side answer may call; `[]` answers from context only |
| `maxToolRounds` | `4` | Tool rounds allowed before the answer is returned as it stands |
| `route` | `null` | Fixed `{ provider, model }`; by default the session's own route |
| `systemPrompt` | `null` | Replacement for the side-question system prompt |

## How it works

The Host half registers a `/btw` command and a small service that snapshots the
parent conversation's text, sends it plus the side thread to `ctx.llm.stream`,
and folds the provider's usage report into the panel's counters. The browser
half registers a right-sidebar tab type and talks to the Host over three
authenticated routes: `POST /api/btw/ask`, `GET /api/btw/state`, and
`POST /api/btw/close`.

### Why a direct model call, not a second Agent

A second Agent would own a real Session, and a Session is written to the
durable log: the dialogue would survive the panel, and its request would be
reconstructed on resume. That contradicts "keep nothing after closing". The side
thread therefore lives in the Host process's memory only, keyed by the parent
session id, and is deleted on close or panel reload. The parent session never
receives an inbox message, a turn, a tool call, or an assistant message from it.

The side request is a plain text conversation: parent instruction messages are
dropped, tool-call blocks from the parent's history are stripped, and the
parent's tool results are folded into text so the new request starts from one
consistent, tool-free transcript. The only tools offered are the read-only
whitelist for the side thread's own lookups.

### Read-only tools without polluting the transcript

A side answer may call `read`, `glob`, and `grep` through `ctx.tools.execute`
with the batch `log` field omitted: the same tool body runs against the same
sandbox and working directory, but no `tool/call` or `tool/result` event reaches
the parent session. The loop is bounded by `maxToolRounds`, and any call outside
the whitelist never executes — the model receives an error result instead.

The whitelist is also intersected with the tools the parent session's last
request actually offered, so a preset that hides `read` from the session hides
it here too.

Schemas are read one definition at a time through `ctx.tools.get(name)` rather
than through `ctx.tools.schemas()`. The bulk call projects the whole registry and
throws when any single tool's parameters cannot be detached; one such tool would
otherwise leave the side request with no tools at all — while the system prompt
still promised them, which is exactly what makes a model write the call out as
markup instead.

If a provider returns the call as prose anyway, the markup is dropped before the
answer reaches the panel and the answer footer marks the answer as
"tool call came back as text". The expanded breakdown names the tools actually in
force, and an answer that received no parent context is marked as such.

### A silent panel is never an outcome

A completed ask is recorded even when the model produced no visible prose, and
the answer row states why: the output cap was reached before any text, the model
only wrote a tool call as markup, the provider failed, or the request was
cancelled. Before this, an empty answer recorded nothing at all, so a broken
answer and a broken panel looked identical.

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
| OpenCode TUI `/btw` | the docs do not say | "not added to the conversation" | a dialog, one answer, copied with `C` |
| this plugin | read-only `read`/`glob`/`grep` | Host memory, dropped on close | yes, in the panel |

Two things come straight from the OpenCode TUI: the running state stays visible
outside the answer surface (there it is a `/btw` marker in the prompt footer;
here it is the busy row and the panel's own footer), and the answer can be copied
whole — there with `C`, here with a copy control in the answer footer.

## Verify

```sh
npm test          # or: node tests/verify.mjs
```

The test loads both halves against stub Cordis contexts and checks the command,
the three routes, the request assembly, the metrics fold, and every client
registration (tab type, guide entry, panel body, command row, close handler).
No network access and no DSH installation are needed, so the same command runs
in GitHub Actions on Node 22 and 24.

## License

[MIT](./LICENSE) © 2026 1bigmouse

