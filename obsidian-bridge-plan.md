# Obsidian ↔ pi bridge — design notes

Researched 2026-09-13/14. **Nothing has been built.** This is the plan and the
findings behind it, so the work can start cold without repeating the research.

## The goal

Chat with **pi itself** (agent, tools, skills, sessions) from inside Obsidian,
rather than chatting with a bare model.

## What already exists, and why it isn't enough

| | what it is | why it falls short |
|---|---|---|
| `pi-web` on `:8504` | pi's own web UI, already bound `0.0.0.0` | Works today via Obsidian's **Web Viewer** core plugin (or Custom Frames) as an iframe pane. But it is side-by-side, not integrated: pi can't see the vault, Obsidian can't see the conversation. |
| llama-proxy on `:1234/v1` | OpenAI-compatible, 8 model ids | Obsidian plugins talk to it today with zero work — but that is the *model*, not pi. No tools, no skills, no session continuity. |
| pi itself | CLI + extension host | **Has no OpenAI-compatible server.** No `serve`, no `--port`, nothing listens. Confirmed from `pi --help`. pi is a *consumer* of OpenAI endpoints (like hermes routes), not a provider of one. |

`pi-web`'s HTTP surface is a single-page app with a catch-all route: `/v1/models`,
`/api/models`, `/api/chat` all return the HTML shell with status 200. Only
`/api/sessions` is a real route (400 on a bare GET). Do not mistake those 200s
for an API — that cost 10 minutes of the research.

## The substrate: RPC mode / AgentSession

Documented in `docs/rpc.md` inside the installed package
(`~/.nvm/versions/node/v22.22.3/lib/node_modules/@earendil-works/pi-coding-agent/`),
~1500 lines. Two ways in, both exported from the package root:

- **`AgentSession`** — import pi as a **library**. `new AgentSession(config)`,
  `prompt(text, options)`, `abort()`, `dispose()`. The docs explicitly recommend
  this over subprocesses for Node clients. **Preferred route.**
- **`RpcClient` / `pi --mode rpc`** — JSONL over stdin/stdout, commands in,
  events out, `id` correlation. Use only if the bridge is not Node.
  Framing gotcha, called out in the docs: split on `\n` **only**. Node's
  `readline` is explicitly non-compliant (it also splits on U+2028/U+2029,
  which are legal inside JSON strings).

What RPC/AgentSession gives that a scraper wouldn't:

- `message_update` events = **real incremental deltas** → genuine SSE streaming,
  not chunking a finished reply.
- `tool_execution_start / update / end` as **separate** events → tool activity can
  be surfaced or suppressed deliberately, instead of being tangled in the text.
- Session state, compaction, auto-retry, queueing — all built in.
- `streamingBehavior: "steer"` — interrupt a running turn. No OpenAI endpoint
  models this; pure upside if ever wanted.

## What to build

A small Node service. OpenAI HTTP on one side, `AgentSession` on the other.

**Endpoints**
- `GET /v1/models` — Obsidian calls this to populate its picker. Return one fake
  id, e.g. `pi`.
- `POST /v1/chat/completions` — streaming and non-streaming.
- `GET /health` — optional, for the dashboard.

**Four internal pieces**
1. **Session per conversation.** `new AgentSession({...})` rooted at the vault.
   Map conversation → session so follow-ups continue it. `dispose()` on age-out.
2. **Send ONLY the last user message.** The critical rule. Obsidian assumes a
   stateless endpoint and resends the whole history every turn; pi keeps its own
   state. Forwarding the history duplicates the conversation. Bonus: pi's
   compaction then handles long chats, so Obsidian cannot blow the context.
3. **Event → SSE translator.** `message_update` → content deltas; `agent_end` →
   close. Decide tool visibility (see below).
4. **Abort wiring.** HTTP client disconnect → `session.abort()`, so closing a
   chat doesn't leave pi grinding.

## Configuration outside the code

- **Vault must be added to `~/.pi/agent/trust.json`** (currently lists only
  `/home/mark/local-project`, `/mnt/projects/edu-rbwe`,
  `/mnt/projects/house-planning`, `/mnt/projects/pi-playground`).
  Mark's pi does **not** prompt for approvals — trust is pre-granted per
  directory — which is why a headless client works at all, but it also means
  granting the vault = unprompted bash + file writes against the notes.
  Consider a dedicated subdirectory, or run the bridge with `--no-tools` /
  a `--tools` allowlist for chat-only.
- Pick a port, bind LAN-wide like the other services, run as a
  `systemd --user` unit next to `pi-web`.
- Obsidian side: any OpenAI-compatible plugin — **Local LLM Helper** (explicitly
  supports vLLM), **Any LLM** (choose "Custom (OpenAI-compatible)"), or
  **Copilot**. Base URL `http://<MODEL_HOST>:<port>/v1`, blank API key,
  model `pi`.

## Two decisions to make BEFORE writing code

Both are annoying to change once habits form around them.

1. **Is tool activity visible?** Suppress entirely (Obsidian sees only prose), or
   emit one-liners like *"reading config.json"*. OpenAI's format has no
   vocabulary for "the agent is doing things" — this choice decides how faithful
   the experience feels, and it is the main risk in the whole project.
2. **Vault trust: full, or sandboxed subdirectory?**

## Effort

A few hundred lines, one focused session. Suggested order: minimal
non-streaming round trip first to prove it, then streaming, then tool-event
handling. The plumbing is easy; the impedance mismatch (stateless chat format
vs stateful agent) is where the judgement goes.

## Prior art on this box

`pi-mcp-adapter` (installed) is already a protocol bridge, and `pi-llama-cpp`
runs a `ServerManager` from inside an extension — so "extension that manages a
server" is an established pattern here if the bridge should live as a pi
extension rather than a standalone service.
