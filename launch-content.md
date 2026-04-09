# ClaudeCockpit v1.0 — Launch Content

Prepared copy for each channel. Replace `[GITHUB_URL]` and `[SCREENSHOT_URL]` with actual links before posting.

---

## Twitter/X Thread

### Tweet 1 (Hook)
I built a visual cockpit for @ClaudeCode sessions.

Browse history. Stream live conversations. Approve tools. Track costs.

Open source, free.

[SCREENSHOT_URL]

### Tweet 2 (Sessions)
Session sidebar with search, day grouping, pinning, and auto-generated titles.

Untitled CLI sessions get concise titles via Haiku in the background — no manual labeling.

[GIF: typing in search, sessions filtering]

### Tweet 3 (Live Chat)
Live streaming with full markdown rendering, collapsible thinking blocks, and interactive tool approval.

Approve or deny Bash, Edit, Write with keyboard shortcuts (Y/N).

[GIF: streaming response with tool approval]

### Tweet 4 (Insights)
Cost tracking with Bedrock pricing estimates. Token breakdown per session. Cache hit stats.

One-click "catch me up" summaries for any session.

[GIF: detail sidebar + summary card]

### Tweet 5 (Tech + CTA)
Built with Lit + Vite + TypeScript. Node.js gateway reads JSONL session files and spawns claude -p subprocesses.

310 tests. MIT licensed. No API key needed — works with your existing Claude Code sessions.

[GITHUB_URL]

#ClaudeCode #DevTools #OpenSource

---

## Hacker News

### Title
Show HN: ClaudeCockpit – Visual dashboard for Claude Code sessions

### First Comment
Hey HN, I built this after using Claude Code heavily for a few months. I wanted a way to browse my session history, re-read old conversations, and have a visual interface for live chat with tool approval.

**How it works:**

ClaudeCockpit reads the JSONL session files that Claude Code writes to `~/.claude/projects/`. The Node.js gateway parses these files and serves them via HTTP + WebSocket. For live chat, it spawns `claude -p --output-format stream-json` subprocesses and streams the output to the browser.

**Stack:** Lit web components, Vite, TypeScript. Custom req/res/event frame protocol over WebSocket. 310 tests (Vitest + jsdom).

**Features:**
- Session browsing with search, pinning, and auto-generated titles (via Haiku)
- Live streaming chat with markdown rendering
- Interactive tool approval (approve/deny Bash, Edit, Write, etc.)
- Token usage and estimated Bedrock cost tracking
- One-click session summaries
- Graceful error handling (reconnection, CLI not found)

It's a personal tool — no auth, no multi-user, no themes. Built for a single power user on macOS, but should work anywhere Claude Code runs.

MIT licensed: [GITHUB_URL]

---

## Reddit — r/ClaudeAI

### Title
I built a visual cockpit for Claude Code — browse sessions, stream live chat, approve tools, track costs [Open Source]

### Body
After using Claude Code heavily for a few months, I wanted a way to browse my session history, re-read old conversations, and have a visual interface for live chat with tool approval. So I built ClaudeCockpit.

**What it does:**
- Browse all your Claude Code sessions across projects, grouped by day
- Stream live conversations with full markdown rendering
- Approve/deny tool use (Bash, Edit, Write) with keyboard shortcuts
- Track token usage and estimated Bedrock costs per session
- Auto-generate titles for untitled CLI sessions
- One-click session summaries to catch up on what happened

**How it works:**
It reads the JSONL files Claude Code writes to `~/.claude/projects/` — no API key or account needed. The gateway spawns `claude -p` subprocesses for live chat. Everything runs locally.

**Quick start:**
```
git clone [GITHUB_URL]
cd ClaudeCockpit
npm install
npm run dev
```

Open localhost:5173 and you'll see all your sessions.

MIT licensed, 310 tests, Lit + Vite + TypeScript.

[SCREENSHOT_URL]

---

## Reddit — r/ChatGPTCoding, r/webdev

### Title
Show-off Saturday: Built a visual dashboard for my AI coding sessions (Claude Code) [Open Source]

### Body
I've been using Claude Code (Anthropic's CLI coding tool) for a while and built a browser dashboard to manage my sessions. It reads session files from disk and provides a visual interface with live streaming, tool approval, cost tracking, and session summaries.

Tech stack: Lit web components, Vite, TypeScript, Node.js gateway with WebSocket streaming. 310 tests.

It's specifically for Claude Code, but the architecture (JSONL reader + streaming gateway + WS protocol) could be adapted for other tools.

MIT licensed: [GITHUB_URL]

---

## Dev.to Blog Post Outline

### Title
I Built a Dashboard for My AI Coding Sessions — Here's What I Learned

### Structure
1. **The problem** — Claude Code sessions pile up, hard to find old conversations, no visual overview
2. **First attempt** — Started with just a JSONL reader, quickly wanted live interaction
3. **Architecture** — Lit + Vite SPA talks to Node.js gateway via WebSocket. Gateway reads session files and spawns Claude processes
4. **Key design decisions:**
   - Light DOM for simplicity (no Shadow DOM)
   - Custom frame protocol (req/res/event) instead of REST
   - Type boundary between gateway and UI (intentional duplication)
   - JSONL recovery for concatenated lines
5. **The hardest parts:**
   - Streaming dedup (same message ID across multiple JSONL lines)
   - Tool result attachment (matching tool_use_id back to parent message)
   - Interactive mode control protocol for tool approval
6. **What's next** — Usage analytics, cost charts, session export
7. **Try it** — Link to repo, screenshot

---

## Claude Code Community (Discord / GitHub Discussions)

### Title
ClaudeCockpit — visual session browser and live chat dashboard

### Body
I built a browser-based dashboard for Claude Code that:
- Reads your existing session JSONL files (no extra setup)
- Provides a searchable session sidebar with auto-generated titles
- Streams live chat with tool approval
- Shows token usage and cost estimates

It's MIT licensed and works with any Claude Code installation. Feedback welcome!

[GITHUB_URL]
