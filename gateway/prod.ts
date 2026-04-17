/**
 * Production entrypoint for ClaudeCockpit.
 *
 * Runs preflight checks, finds a free port, boots the gateway with static dist/
 * serving on the same port, and opens the browser. Invoked via `bin/claude-cockpit.js`
 * after `npm install -g claude-cockpit` or `npx claude-cockpit`.
 */
import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { startGateway } from "./server.ts";

export const DEFAULT_PORT = 18800;
export const MAX_PORT_ATTEMPTS = 10;
const PREFLIGHT_SPAWN_TIMEOUT_MS = 3000;

export type PreflightResult =
  | { ok: true }
  | { ok: false; message: string; fatal: boolean };

/** Parse a Node version string ("v23.1.4" or "22.0.0") and return the major number. */
export function parseNodeMajor(version: string): number {
  const match = /^v?(\d+)/.exec(version);
  return match ? Number(match[1]) : NaN;
}

export function checkNodeVersion(version: string, minMajor = 22): PreflightResult {
  const major = parseNodeMajor(version);
  if (!Number.isFinite(major) || major < minMajor) {
    return {
      ok: false,
      fatal: true,
      message: `ClaudeCockpit requires Node.js ${minMajor} or newer (you have ${version}). Install from https://nodejs.org`,
    };
  }
  return { ok: true };
}

/** Spawn `claude --version` and assert it exits 0. Safe: spawn() with argv never invokes a shell. */
export function checkClaudeCli(
  spawnImpl: typeof spawn = spawn,
): Promise<PreflightResult> {
  return new Promise((resolvePromise) => {
    const failMsg =
      "Claude Code CLI not found on PATH. Install it from https://claude.ai/code";
    let settled = false;
    const done = (r: PreflightResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(r);
      }
    };

    try {
      const proc = spawnImpl("claude", ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        done({ ok: false, fatal: true, message: failMsg });
      }, PREFLIGHT_SPAWN_TIMEOUT_MS);

      proc.on("error", () => {
        clearTimeout(timer);
        done({ ok: false, fatal: true, message: failMsg });
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        done(
          code === 0
            ? { ok: true }
            : { ok: false, fatal: true, message: failMsg },
        );
      });
    } catch {
      done({ ok: false, fatal: true, message: failMsg });
    }
  });
}

/** Check ~/.claude/projects/ exists — non-fatal (informational). */
export async function checkClaudeProjectsDir(
  statImpl: typeof stat = stat,
  home = homedir(),
): Promise<PreflightResult> {
  const path = resolve(home, ".claude/projects");
  try {
    const info = await statImpl(path);
    if (info.isDirectory()) return { ok: true };
  } catch {
    /* fall through */
  }
  return {
    ok: false,
    fatal: false,
    message:
      "No Claude Code sessions found at ~/.claude/projects. Run 'claude' at least once before using ClaudeCockpit",
  };
}

/** Find a free TCP port starting from `start`, retrying up to `maxAttempts` then falling back to OS-assigned. */
export function pickFreePort(
  start = DEFAULT_PORT,
  maxAttempts = MAX_PORT_ATTEMPTS,
  createServerImpl: typeof createServer = createServer,
): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const server = createServerImpl();
      server.once("error", () => {
        server.removeAllListeners();
        server.close();
        resolve(null);
      });
      server.once("listening", () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        server.close(() => resolve(boundPort));
      });
      server.listen(port);
    });

  return (async () => {
    for (let i = 0; i < maxAttempts; i++) {
      const result = await tryPort(start + i);
      if (result !== null) return result;
    }
    const fallback = await tryPort(0);
    return fallback ?? 0;
  })();
}

/** Open a URL in the user's default browser on macOS. Guarded by CI + opt-out env vars. */
export function openBrowser(url: string): void {
  if (process.env.CI || process.env.CLAUDE_COCKPIT_NO_OPEN) return;
  try {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* browser open is best-effort */
  }
}

/** Resolve the built UI path — next to this file in dist/. */
function resolveStaticRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/gateway/prod.js → ../ (dist root, where index.html lives)
  return resolve(here, "..");
}

export async function main(): Promise<void> {
  const nodeCheck = checkNodeVersion(process.versions.node);
  if (!nodeCheck.ok) {
    console.error(nodeCheck.message);
    process.exit(1);
  }

  const cliCheck = await checkClaudeCli();
  if (!cliCheck.ok) {
    console.error(cliCheck.message);
    process.exit(1);
  }

  const projectsCheck = await checkClaudeProjectsDir();
  if (!projectsCheck.ok) {
    console.error(projectsCheck.message);
    process.exit(0);
  }

  const port = await pickFreePort();
  const staticRoot = resolveStaticRoot();
  await startGateway({ port, serveStatic: staticRoot, quiet: true });

  const url = `http://localhost:${port}`;
  console.log(`ClaudeCockpit running at ${url}`);
  openBrowser(url);
}
