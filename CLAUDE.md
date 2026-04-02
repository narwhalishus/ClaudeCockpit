# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**ClaudeCockpit** — personal session cockpit for Claude Code. Browse sessions, resume conversations, stream live responses. Reads JSONL session files from `~/.claude/projects/`, aggregates stats, and provides a chat interface that spawns `claude -p` subprocesses. Built with Lit + Vite + TypeScript.

## Design Principles

1. **Design for Claude Code, not OpenClaw.** Borrow infrastructure patterns (Lit components, WS protocol, CSS tokens) but build around Claude Code's concepts: projects, subagents, plan mode, tasks, permissions, memory.
2. **Personal tool, not a product.** No themes, i18n, onboarding, multi-user, or feature flags. Lean and opinionated for a single power user on macOS.
3. **Read real data first, control later.** Phase 1 is read-only. Phase 2 adds live interaction. Don't over-engineer before knowing the data shape.

## Commands

- `npm run dev` — starts both Vite dev server (:5173) and gateway server (:18800) concurrently
- `npm run dev:ui` — Vite frontend only
- `npm run dev:gateway` — gateway server only (uses `tsx watch`)
- `npm test` — run all tests (`vitest run`, ~256 tests)
- `npm run test:watch` — tests in watch mode
- `npx vitest run tests/gateway/session-store.test.ts` — run a single test file
- `npm run build` — production build to `dist/`

## Project Status

- **Phase 1 (Static Cockpit)**: Complete — read-only views for overview, sessions, projects
- **Phase 2 (Gateway + Live Chat)**: Complete — WebSocket streaming, chat-as-session-cockpit, session resume
- **Phase 2.5 (Chat Refinements)**: Complete — session detail sidebar, model selector, conversation summary, overview redesign, structured user messages + per-tool colored symbols, gateway resilience fix
- **Phase 3 (Usage Analytics)**: Planned — token breakdown by day/model/project, Bedrock cost tracking

Full roadmap with checklists: `roadmap.html` | Changelog: `changelog.html`

## Architecture

```
Lit + Vite (SPA :5173) ──/api/*──> Gateway (Node.js :18800)
                        <══/ws══>   req/res/event frames
                                         │
                              ┌──────────┴──────────┐
                              v                      v
                     claude -p --stream-json    ~/.claude/projects/*.jsonl
```

### Gateway (`gateway/`)

Node.js HTTP + WebSocket server on port 18800.

- **HTTP**: `/api/overview`, `/api/sessions`, `/api/projects`, `/api/health` — overview and sessions accept `?project=<id>` for project-scoped results
- **WebSocket**: `/ws` — custom frame protocol (`gateway/protocol/frames.ts`) with three frame types: `req` (client->server), `res` (server->client response), `event` (server->client push)
- WS methods: `overview.get` (accepts `project`), `sessions.list` (accepts `project`), `projects.list`, `sessions.messages`, `sessions.rename`, `sessions.summarize`, `chat.send`, `chat.abort`, `tool.respond`

Key services:
- `gateway/services/session-store.ts` — JSONL parser + data aggregation. `convertToMessages()` is the most complex function: collapses streaming assistant chunks (same msg ID), matches `tool_result` blocks back to parent assistant message's tool/agent blocks via `tool_use_id`. Malformed JSONL lines are logged and skipped. `splitConcatenatedJson()` recovers data when Claude Code writes two JSON objects on one line (missing trailing newline).
- `gateway/services/claude-cli.ts` — spawns `claude -p --output-format stream-json --verbose`, streams NDJSON as events. Interactive mode adds `--input-format stream-json --permission-mode default` for bidirectional control protocol (tool approval via `control_request`/`control_response`). Prompt written via stdin as JSON. Resume uses `claude -r <session-id>`.
- `gateway/services/pricing.ts` — Bedrock pricing estimates per model (source: AWS Bedrock on-demand pricing, us-east-1). Used by `computeOverviewStats` for the estimated cost card. Unknown models log a warning and fall back to Sonnet pricing.
- `gateway/server.ts` — HTTP + WS server. WS methods dispatched via a `wsHandlers` record of named handler functions. Param extraction uses `getString`/`getNumber`/`requireString` helpers for type-safe access.

### Frontend (`ui/`)

Lit web components in **light DOM** (`createRenderRoot() { return this; }`). All styling via global CSS in `ui/styles/`. No Shadow DOM.

- `ui/app.ts` — `<cockpit-app>` shell: sidebar nav, **global project selector**, hash-based routing (`#tab/projectId`), dual WS+HTTP data fetching. Subscribes to `chat.close` events to re-fetch stats (live cost updates). Owns `selectedProjectId` state and passes it to all views.
- `ui/gateway.ts` — `GatewayBrowserClient`: request/response matching by frame ID, event subscriptions, exponential backoff reconnection
- `ui/views/chat.ts` — **Session cockpit**: three-panel layout (collapsible session sidebar + conversation + toggleable detail sidebar). Sessions grouped by day, pinned sessions (localStorage), paginated message history, streaming display with cursor, inline collapsible agent/tool blocks. Detail sidebar shows session metadata (model, tokens, duration, cache, cwd). Markdown rendered via `marked` with post-render `sanitizeHtml()` to prevent XSS.
- `ui/views/overview.ts` — 6 stat cards (sessions, projects, tokens, est. cost, uptime, avg tokens/session) + recent sessions list
- `ui/views/projects.ts` — projects grouped by directory
- `ui/utils/format.ts` — shared formatting utilities: `formatTokens`, `formatRelativeTime`, `formatDuration`, `formatUptime`, `formatCost`, `shortenHomePath`
- `ui/constants.ts` — shared UI constants: `MODEL_OPTIONS`, `CHAT_REQUEST_TIMEOUT_MS`, `SUMMARY_REQUEST_TIMEOUT_MS`, `SESSION_PAGE_SIZE`, `SESSION_OLDER_PAGE_SIZE`

### Type System

Types intentionally duplicated: `gateway/types.ts` has raw JSONL parsing types (`RawSessionLine`, `RawContentBlock`) + API response shapes. `ui/types.ts` has simplified UI-facing versions. This is a deliberate boundary — gateway types model Claude Code's file format, UI types model what gets rendered.

### Control Protocol Flow

Interactive chat uses Claude Code's bidirectional control protocol for tool approval:
1. Gateway spawns `claude -p --input-format stream-json --permission-mode default`
2. Prompt sent via stdin as structured JSON `{ type: "user", message: { role: "user", content: "..." } }`
3. When Claude requests tool approval, it emits `{ type: "control_request", request_id, request }` on stdout
4. Gateway forwards to UI as `tool.approval` event; UI shows approve/deny banner
5. User response sent back via `tool.respond` WS method → gateway writes `control_response` to stdin
6. If the UI disconnects, the gateway auto-denies pending approvals and aborts running processes

### Testing

Vitest + jsdom. Tests in `tests/` mirror source structure:

- `tests/gateway/session-store.test.ts` — `splitConcatenatedJson`, `summarizeSession`, `consolidateMessages`, `computeOverviewStats`, `buildTranscript`
- `tests/gateway/convert-messages.test.ts` — `convertToMessages` (streaming dedup, tool attachment, filtering)
- `tests/gateway/claude-cli.test.ts` — `buildArgs`, `handleParsedLine` (all content block types), `processBuffer`
- `tests/gateway/server.test.ts` — `handleWsRequest` (mocked services, all WS methods including chat.send and sessions.summarize)
- `tests/gateway/frames.test.ts` — frame serialization/parsing, round-trips, helper constructors, per-type required field validation
- `tests/gateway/pricing.test.ts` — per-model cost estimation
- `tests/ui/chat.test.ts` — markdown rendering, session titles, sidebar/detail panels, stream handlers, summary, XSS sanitization, localStorage resilience
- `tests/ui/gateway.test.ts` — `GatewayBrowserClient` (request/response matching, events, connection state)
- `tests/ui/overview.test.ts` — overview component rendering (6 stat cards, recent sessions)
- `tests/ui/settings.test.ts` — model selector rendering and localStorage persistence
- `tests/ui/tool-approval.test.ts` — tool approval banner rendering and actions
- `tests/ui/app.test.ts` — app shell, project selector, hash routing
- `tests/ui/format.test.ts` — shared format utilities including `shortenHomePath`

Gateway tests are pure unit tests (no filesystem, no real processes). UI tests render Lit components into jsdom, assert DOM via `updateComplete`. To add tests: create a file in `tests/` mirroring the source path, import the function/component, and use vitest helpers.

## JSONL Data Model

Session files: `~/.claude/projects/<encoded-path>/<session-id>.jsonl`

- Project path encoding: `-Users-bryao-code-myproject` -> `/Users/bryao/code/myproject` (dashes -> slashes)
- Line types: `user`, `assistant`, `file-history-snapshot`, `system`, `agent-name`, `custom-title`, `last-prompt`, `queue-operation`
- Streaming: multiple JSONL lines per assistant response share the same `message.id` — must deduplicate
- Subagents: inlined in parent session (not separate files). `tool_use` blocks with `name: "Agent"` mark spawns. `sourceToolAssistantUUID` links tool results back.
- `isSidechain: true` marks branched conversations — filter these out of main display
- `entrypoint`: `"cli"` or `"claude-vscode"` — where the session was started

## Vite Dev Proxy

Vite proxies `/api` -> `http://localhost:18800` and `/ws` -> `ws://localhost:18800` so frontend runs against gateway without CORS issues.

## TypeScript Notes

- `useDefineForClassFields: false` in tsconfig — required for Lit decorator compatibility
- `experimentalDecorators: true` — Lit uses `@customElement`, `@property`, `@state`
- Accent color: `#da7756` (Claude terracotta)
