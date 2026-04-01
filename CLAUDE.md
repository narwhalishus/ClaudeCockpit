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
- `npm test` — run all tests (`vitest run`, 61 tests)
- `npm run test:watch` — tests in watch mode
- `npx vitest run tests/gateway/session-store.test.ts` — run a single test file
- `npm run build` — production build to `dist/`

## Project Status

- **Phase 1 (Static Cockpit)**: Complete — read-only views for overview, sessions, projects
- **Phase 2 (Gateway + Live Chat)**: Complete — WebSocket streaming, chat-as-session-cockpit, session resume
- **Phase 2.5 (Chat Refinements)**: Next up — markdown rendering, tool approval modal, model selector, conversation summary, entrypoint badges
- **Phase 3 (Usage Analytics)**: Planned — token breakdown by day/model/project, Bedrock cost tracking

Full roadmap with checklists: `plan.html`

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
- WS methods: `overview.get` (accepts `project`), `sessions.list` (accepts `project`), `projects.list`, `sessions.messages`, `sessions.rename`, `chat.send`, `chat.abort`

Key services:
- `gateway/services/session-store.ts` — JSONL parser + data aggregation. `convertToMessages()` is the most complex function: collapses streaming assistant chunks (same msg ID), matches `tool_result` blocks back to parent assistant message's tool/agent blocks via `tool_use_id`.
- `gateway/services/claude-cli.ts` — spawns `claude -p --output-format stream-json --verbose`, streams NDJSON as events. Prompt written via stdin (not args) to avoid ARG_MAX limits. Resume uses `claude -r <session-id>`.

### Frontend (`ui/`)

Lit web components in **light DOM** (`createRenderRoot() { return this; }`). All styling via global CSS in `ui/styles/`. No Shadow DOM.

- `ui/app.ts` — `<cockpit-app>` shell: sidebar nav, **global project selector**, hash-based routing (`#tab/projectId`), dual WS+HTTP data fetching. Owns `selectedProjectId` state and passes it to all views.
- `ui/gateway.ts` — `GatewayBrowserClient`: request/response matching by frame ID, event subscriptions, exponential backoff reconnection
- `ui/views/chat.ts` — **Session cockpit**: two-panel layout (session sidebar + conversation). Project switcher, sessions grouped by day, pinned sessions (localStorage), paginated message history, streaming display with cursor, inline collapsible agent/tool blocks
- `ui/views/sessions.ts` — sortable/filterable data table, click row -> opens in chat
- `ui/views/overview.ts` — stat cards (sessions, projects, tokens, cache)
- `ui/views/projects.ts` — projects grouped by directory

### Type System

Types intentionally duplicated: `gateway/types.ts` has raw JSONL parsing types (`RawSessionLine`, `RawContentBlock`) + API response shapes. `ui/types.ts` has simplified UI-facing versions. This is a deliberate boundary — gateway types model Claude Code's file format, UI types model what gets rendered.

### Testing

Vitest + jsdom. Tests in `tests/` mirror source structure. Gateway tests are pure unit tests on data-transform functions (no filesystem). UI tests render Lit components into jsdom, assert DOM via `updateComplete`.

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
