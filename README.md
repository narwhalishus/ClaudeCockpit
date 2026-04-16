# ClaudeCockpit

A visual cockpit for [Claude Code](https://claude.ai/code) sessions. Browse session history, stream live conversations, approve tool use, and track token costs — all from your browser.

![ClaudeCockpit screenshot](https://github.com/user-attachments/assets/placeholder-screenshot.png)

## What it does

- **Browse sessions** — View all Claude Code sessions across projects, grouped by day, with search and pinning
- **Stream live chat** — Send prompts and watch Claude respond in real time with markdown rendering
- **Approve tools** — Interactive tool approval flow for Bash, Edit, Write, and other tools
- **Track costs** — Estimated Bedrock pricing by model, token breakdown per session, cache hit stats
- **Auto-title sessions** — Untitled CLI sessions get concise titles generated via Haiku
- **Summarize sessions** — One-click AI summary to catch up on what happened in a session
- **Dark & light themes** — Segmented picker in Settings with instant toggle and FOUC-free reload

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org/) 22+ and [Claude Code CLI](https://claude.ai/code) installed.

```bash
git clone https://github.com/bryao/ClaudeCockpit.git
cd ClaudeCockpit
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The gateway runs on `:18800` and Vite proxies API/WS requests automatically.

## Architecture

```
Lit + Vite (SPA :5173) ──/api/*──> Gateway (Node.js :18800)
                        <══/ws══>   req/res/event frames
                                         │
                              ┌──────────┴──────────┐
                              v                      v
                     claude -p --stream-json    ~/.claude/projects/*.jsonl
```

- **Frontend** — Lit web components in light DOM, global CSS, hash-based routing
- **Gateway** — Node.js HTTP + WebSocket server. Reads JSONL session files from `~/.claude/projects/`, spawns `claude -p` subprocesses for live chat
- **Protocol** — Custom frame protocol over WebSocket: `req` (client→server), `res` (server→client), `event` (server push)

## Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server + gateway concurrently |
| `npm run dev:ui` | Frontend only |
| `npm run dev:gateway` | Gateway only (tsx watch) |
| `npm test` | Run all tests (vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run typecheck` | TypeScript type check |
| `npm run ci` | Full pipeline: typecheck + test + build |
| `npm run build` | Production build to `dist/` |

## Project status

- **Phase 1** (Static Cockpit) — Complete
- **Phase 2** (Gateway + Live Chat) — Complete
- **Phase 2.5** (Chat Refinements) — Complete
- **Phase 3** (Usage Analytics) — Planned

See [roadmap.html](public/roadmap.html) for the full roadmap and [changelog.html](public/changelog.html) for release history.

## License

[MIT](LICENSE) — Copyright (c) 2026 Bryan Yao
