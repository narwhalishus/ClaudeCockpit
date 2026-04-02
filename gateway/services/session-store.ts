import { readdir, readFile, stat, appendFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type {
  RawSessionLine,
  RawContentBlock,
  SessionSummary,
  OverviewStats,
  ProjectInfo,
  ChatMessage,
  AgentBlock,
  ToolBlock,
  SessionMessagesResult,
} from "../types.ts";
import {
  TOOL_RESULT_TRUNCATE_CHARS,
  TRANSCRIPT_MAX_CHARS,
  AGENT_PROMPT_PREVIEW_CHARS,
} from "../constants.ts";
import { estimateSessionCost } from "./pricing.ts";

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

/** Decode a Claude Code project directory name back to its path */
export function decodeProjectPath(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

/**
 * Split a line containing multiple concatenated JSON objects.
 *
 * Claude Code sometimes writes JSONL entries without a trailing newline,
 * causing two valid objects to end up on one line: `{...}{...}`.
 * This uses brace-depth tracking (respecting strings) to find boundaries.
 */
export function splitConcatenatedJson(line: string): unknown[] {
  const results: unknown[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = 0;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          results.push(JSON.parse(line.slice(start, i + 1)));
        } catch {
          // Segment still malformed — skip it
        }
        start = i + 1;
      }
    }
  }

  return results;
}

/** Parse a single JSONL file into an array of raw session lines */
async function parseJsonlFile(filePath: string): Promise<RawSessionLine[]> {
  const content = await readFile(filePath, "utf-8");
  const lines: RawSessionLine[] = [];
  const rawLines = content.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Try to recover concatenated JSON objects (CC sometimes omits newlines)
      const recovered = splitConcatenatedJson(trimmed);
      if (recovered.length > 0) {
        lines.push(...(recovered as RawSessionLine[]));
      } else {
        console.warn(`Malformed JSONL at ${filePath}:${i + 1} — skipping line`);
      }
    }
  }
  return lines;
}

/** Extract the first user message text from content */
export function extractText(
  content: string | { type: string; text?: string }[]
): string {
  if (typeof content === "string") return content;
  for (const block of content) {
    if (block.type === "text" && block.text) return block.text;
  }
  return "";
}

/** Aggregate a parsed JSONL file into a session summary */
export function summarizeSession(
  lines: RawSessionLine[],
  projectId: string,
  projectPath: string
): SessionSummary | null {
  // Filter to actual user/assistant messages (not snapshots, not sidechain)
  const messages = lines.filter(
    (l) =>
      (l.type === "user" || l.type === "assistant") &&
      !l.isSidechain &&
      l.timestamp
  );

  if (messages.length === 0) return null;

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];

  let model = "";
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let messageCount = 0;

  // Track seen message IDs to avoid double-counting streaming chunks
  const seenMsgIds = new Set<string>();

  for (const line of messages) {
    if (line.type === "user") {
      messageCount++;
      continue;
    }

    // For assistant messages, deduplicate by message ID
    // Claude Code writes multiple lines per streaming response (same msg ID)
    const msgId = line.message?.id;
    if (msgId && seenMsgIds.has(msgId)) continue;
    if (msgId) seenMsgIds.add(msgId);

    messageCount++;

    if (line.message?.model && !model) {
      model = line.message.model;
    }

    const usage = line.message?.usage;
    if (usage) {
      totalInput += usage.input_tokens ?? 0;
      totalOutput += usage.output_tokens ?? 0;
      totalCacheRead += usage.cache_read_input_tokens ?? 0;
      totalCacheCreation += usage.cache_creation_input_tokens ?? 0;
    }
  }

  // Get the first user prompt with actual text as preview
  let firstPrompt = "";
  for (const m of messages) {
    if (m.type !== "user" || !m.message?.content) continue;
    const text = extractText(m.message.content).trim();
    // Skip tool results and system interrupts
    if (text && !text.startsWith("[Request interrupted")) {
      firstPrompt = text.slice(0, 200);
      break;
    }
  }

  // Look for custom-title lines (last one wins — user may rename multiple times)
  let customTitle: string | undefined;
  for (const line of lines) {
    if (line.type === "custom-title" && line.customTitle) {
      customTitle = line.customTitle;
    }
  }

  const summary: SessionSummary = {
    sessionId: firstMsg.sessionId ?? basename(projectPath),
    projectId,
    projectPath: decodeProjectPath(projectId),
    cwd: firstMsg.cwd ?? "",
    startedAt: firstMsg.timestamp!,
    lastMessageAt: lastMsg.timestamp!,
    messageCount,
    model,
    version: firstMsg.version ?? "",
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreationTokens: totalCacheCreation,
    firstPrompt,
  };
  if (customTitle) summary.customTitle = customTitle;
  return summary;
}

/** List all project directories */
export async function listProjects(): Promise<ProjectInfo[]> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];

  for (const dir of dirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    // Count JSONL files
    const files = await readdir(dirPath).catch((): string[] => []);
    const jsonlFiles = files.filter((f: string) => f.endsWith(".jsonl"));

    // Find the most recent JSONL file
    let lastActive: string | null = null;
    for (const f of jsonlFiles) {
      const fStat = await stat(join(dirPath, f)).catch(() => null);
      if (fStat) {
        const mtime = fStat.mtime.toISOString();
        if (!lastActive || mtime > lastActive) {
          lastActive = mtime;
        }
      }
    }

    projects.push({
      id: dir,
      path: decodeProjectPath(dir),
      sessionCount: jsonlFiles.length,
      lastActive,
    });
  }

  return projects.sort(
    (a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? "")
  );
}

/** List project directory names, optionally filtered to a single project */
async function getProjectDirs(projectId?: string): Promise<string[]> {
  if (projectId) return [projectId];
  try {
    const dirs = await readdir(PROJECTS_DIR);
    const result: string[] = [];
    for (const dir of dirs) {
      const dirStat = await stat(join(PROJECTS_DIR, dir)).catch(() => null);
      if (dirStat?.isDirectory()) result.push(dir);
    }
    return result;
  } catch {
    return [];
  }
}

/** List all sessions, optionally filtered by project */
export async function listSessions(
  projectId?: string
): Promise<SessionSummary[]> {
  const projectDirs = await getProjectDirs(projectId);

  const sessions: SessionSummary[] = [];

  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    for (const file of jsonlFiles) {
      try {
        const lines = await parseJsonlFile(join(dirPath, file));
        const summary = summarizeSession(lines, dir, decodeProjectPath(dir));
        if (summary) {
          sessions.push(summary);
        }
      } catch {
        // Skip files that can't be parsed
      }
    }
  }

  return sessions.sort(
    (a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt)
  );
}

/** Pure aggregation of sessions into overview stats (no I/O).
 *  Returns everything except gatewayStartedAt — the server adds that. */
export function computeOverviewStats(
  sessions: SessionSummary[],
  totalProjects: number
): Omit<OverviewStats, "gatewayStartedAt"> {
  const now = new Date();
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).toISOString();

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let sessionsToday = 0;
  let estimatedTotalCostUsd = 0;

  for (const s of sessions) {
    totalInput += s.totalInputTokens;
    totalOutput += s.totalOutputTokens;
    totalCacheRead += s.totalCacheReadTokens;
    totalCacheCreation += s.totalCacheCreationTokens;
    if (s.lastMessageAt >= todayStart) {
      sessionsToday++;
    }
    estimatedTotalCostUsd += estimateSessionCost(
      s.model,
      s.totalInputTokens,
      s.totalOutputTokens,
      s.totalCacheReadTokens,
      s.totalCacheCreationTokens,
    );
  }

  return {
    totalSessions: sessions.length,
    totalProjects,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreationTokens: totalCacheCreation,
    sessionsToday,
    estimatedTotalCostUsd,
    recentSessions: sessions.slice(0, 10),
  };
}

/** Get overview statistics, optionally scoped to a single project */
export async function getOverviewStats(
  projectId?: string
): Promise<OverviewStats> {
  const sessions = await listSessions(projectId);
  const totalProjects = projectId ? 1 : (await listProjects()).length;
  return computeOverviewStats(sessions, totalProjects);
}

// ---------------------------------------------------------------------------
// Session message loading (for chat history)
// ---------------------------------------------------------------------------

/** Find the JSONL file for a session across all projects */
async function findSessionFile(
  sessionId: string,
  projectId?: string
): Promise<{ filePath: string; projectId: string } | null> {
  const dirsToSearch = await getProjectDirs(projectId);

  for (const dir of dirsToSearch) {
    const filePath = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    const exists = await stat(filePath).catch(() => null);
    if (exists) {
      return { filePath, projectId: dir };
    }
  }
  return null;
}

/** Extract text, thinking, agent, and tool blocks from a content block array. */
interface ExtractedBlocks {
  text: string;
  thinking: string;
  agents: AgentBlock[];
  tools: ToolBlock[];
}

function extractBlocks(content: RawContentBlock[]): ExtractedBlocks {
  let text = "";
  let thinking = "";
  const agents: AgentBlock[] = [];
  const tools: ToolBlock[] = [];

  for (const block of content) {
    if (block.type === "text" && block.text) {
      text += block.text;
    } else if (block.type === "thinking" && block.thinking) {
      thinking += block.thinking;
    } else if (block.type === "tool_use" && block.name && block.id) {
      if (block.name === "Agent") {
        const input = block.input as Record<string, string> | undefined;
        agents.push({
          toolUseId: block.id,
          description: input?.description ?? "",
          subagentType: input?.subagent_type ?? "",
          prompt: (input?.prompt ?? "").slice(0, AGENT_PROMPT_PREVIEW_CHARS),
        });
      } else {
        tools.push({
          toolUseId: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  return { text, thinking, agents, tools };
}

/**
 * Convert raw JSONL lines into ChatMessage objects for the UI.
 *
 * Algorithm:
 * 1. Iterate lines, skipping sidechains and lines without timestamps.
 * 2. For user lines: attach tool_result blocks to parent assistant's
 *    tool/agent blocks (via tool_use_id); extract real text as user messages.
 * 3. For assistant lines: if msg.id was already seen, merge as streaming chunk
 *    (dedup text via endsWith guard, concat thinking, add new tool_use blocks).
 *    Otherwise, create a new message via extractBlocks().
 * 4. Track pending tool_use_ids in maps so step 2 can attach results later.
 * 5. Consolidation pass: merge tool-only assistant messages into the preceding
 *    assistant bubble to reduce visual noise from rapid tool-call round-trips.
 */
export function convertToMessages(lines: RawSessionLine[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Map tool_use_id → pending agent/tool block (to attach results later)
  const pendingAgents = new Map<string, { msgIdx: number; agentIdx: number }>();
  const pendingTools = new Map<string, { msgIdx: number; toolIdx: number }>();
  // Track seen assistant message IDs to collapse streaming chunks
  const seenMsgIds = new Map<string, number>(); // msgId → index in messages[]

  for (const line of lines) {
    // Skip non-conversation lines
    if (line.isSidechain) continue;
    if (!line.timestamp) continue;

    if (line.type === "user") {
      const content = line.message?.content;
      if (!content) continue;

      // Check if this is a tool_result feedback (not a real user message)
      if (Array.isArray(content)) {
        // User messages with only tool_result blocks are tool feedback —
        // attach results to the parent assistant message's tool/agent blocks
        for (const block of content as RawContentBlock[]) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const agentRef = pendingAgents.get(block.tool_use_id);
            if (agentRef) {
              const msg = messages[agentRef.msgIdx];
              if (msg?.agents?.[agentRef.agentIdx]) {
                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                msg.agents[agentRef.agentIdx].result =
                  resultText.slice(0, TOOL_RESULT_TRUNCATE_CHARS);
              }
              pendingAgents.delete(block.tool_use_id);
              continue;
            }

            const toolRef = pendingTools.get(block.tool_use_id);
            if (toolRef) {
              const msg = messages[toolRef.msgIdx];
              if (msg?.tools?.[toolRef.toolIdx]) {
                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content);
                msg.tools[toolRef.toolIdx].result = resultText.slice(0, TOOL_RESULT_TRUNCATE_CHARS);
              }
              pendingTools.delete(block.tool_use_id);
              continue;
            }
          }

          // If it has a real text block, treat as a user message
          if (block.type === "text" && block.text?.trim()) {
            const text = block.text.trim();
            if (text.startsWith("[Request interrupted")) continue;
            messages.push({
              uuid: line.uuid ?? "",
              role: "user",
              content: text,
              timestamp: line.timestamp,
            });
          }
        }
        continue;
      }

      // Plain string content
      const text =
        typeof content === "string" ? content : extractText(content);
      if (!text.trim()) continue;

      messages.push({
        uuid: line.uuid ?? "",
        role: "user",
        content: text.trim(),
        timestamp: line.timestamp,
      });
      continue;
    }

    if (line.type === "assistant") {
      const msg = line.message;
      if (!msg) continue;

      const msgId = msg.id;

      // If we've already seen this message ID, this is a streaming chunk —
      // merge content into the existing message
      if (msgId && seenMsgIds.has(msgId)) {
        const existingIdx = seenMsgIds.get(msgId)!;
        const existing = messages[existingIdx];
        if (!existing) continue;

        // Extract new content from this chunk
        const content = msg.content;
        if (Array.isArray(content)) {
          for (const block of content as RawContentBlock[]) {
            if (block.type === "text" && block.text) {
              // Only append if this text isn't already in the message
              // (streaming chunks sometimes repeat content)
              if (!existing.content.endsWith(block.text)) {
                existing.content += block.text;
              }
            }
            if (block.type === "thinking" && block.thinking) {
              existing.thinking = (existing.thinking ?? "") + block.thinking;
            }
            if (block.type === "tool_use" && block.name && block.id) {
              if (block.name === "Agent") {
                const input = block.input as Record<string, string> | undefined;
                if (!existing.agents) existing.agents = [];
                const agentIdx = existing.agents.length;
                existing.agents.push({
                  toolUseId: block.id,
                  description: input?.description ?? "",
                  subagentType: input?.subagent_type ?? "",
                  prompt: (input?.prompt ?? "").slice(0, AGENT_PROMPT_PREVIEW_CHARS),
                });
                pendingAgents.set(block.id, {
                  msgIdx: existingIdx,
                  agentIdx,
                });
              } else {
                if (!existing.tools) existing.tools = [];
                const toolIdx = existing.tools.length;
                existing.tools.push({
                  toolUseId: block.id,
                  name: block.name,
                  input: block.input,
                });
                pendingTools.set(block.id, {
                  msgIdx: existingIdx,
                  toolIdx,
                });
              }
            }
          }
        }
        // Update timestamp to the latest chunk
        existing.timestamp = line.timestamp;
        continue;
      }

      // New assistant message — extract all content blocks
      const content = msg.content;
      const { text: textContent, thinking: thinkingContent, agents, tools } =
        typeof content === "string"
          ? { text: content, thinking: "", agents: [] as AgentBlock[], tools: [] as ToolBlock[] }
          : Array.isArray(content)
            ? extractBlocks(content as RawContentBlock[])
            : { text: "", thinking: "", agents: [] as AgentBlock[], tools: [] as ToolBlock[] };

      const newMsg: ChatMessage = {
        uuid: line.uuid ?? "",
        role: "assistant",
        content: textContent,
        timestamp: line.timestamp,
        model: msg.model,
      };
      if (thinkingContent) newMsg.thinking = thinkingContent;
      if (agents.length > 0) newMsg.agents = agents;
      if (tools.length > 0) newMsg.tools = tools;

      const idx = messages.length;
      messages.push(newMsg);

      if (msgId) seenMsgIds.set(msgId, idx);

      // Register pending agent/tool blocks for result attachment
      for (let i = 0; i < agents.length; i++) {
        pendingAgents.set(agents[i].toolUseId, { msgIdx: idx, agentIdx: i });
      }
      for (let i = 0; i < tools.length; i++) {
        pendingTools.set(tools[i].toolUseId, { msgIdx: idx, toolIdx: i });
      }
      continue;
    }
  }

  // ── Consolidation pass ──────────────────────────────────────────────
  // Merge tool-only assistant messages into the preceding assistant bubble.
  // A "tool-only" message has no meaningful text — just tool/agent blocks.
  // This collapses rapid tool-call round-trips into one conversation bubble.
  return consolidateMessages(messages);
}

/** Merge tool-only assistant messages into the previous assistant message */
export function consolidateMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    const prev = result[result.length - 1];
    const isToolOnly =
      msg.role === "assistant" &&
      !msg.content.trim() &&
      (msg.tools?.length || msg.agents?.length);

    if (isToolOnly && prev?.role === "assistant") {
      // Merge tools/agents into a new object (no in-place mutation)
      result[result.length - 1] = {
        ...prev,
        agents: [...(prev.agents ?? []), ...(msg.agents ?? [])],
        tools: [...(prev.tools ?? []), ...(msg.tools ?? [])],
        timestamp: msg.timestamp,
      };
    } else {
      result.push({ ...msg });
    }
  }

  return result;
}

/**
 * Load messages from a session, with pagination.
 * Returns the last `limit` messages (most recent), with offset from the end.
 */
export async function getSessionMessages(
  sessionId: string,
  projectId?: string,
  limit = 50,
  beforeIndex?: number
): Promise<SessionMessagesResult | null> {
  const found = await findSessionFile(sessionId, projectId);
  if (!found) return null;

  const lines = await parseJsonlFile(found.filePath);
  const allMessages = convertToMessages(lines);

  const total = allMessages.length;
  const endIdx = beforeIndex ?? total;
  const startIdx = Math.max(0, endIdx - limit);
  const page = allMessages.slice(startIdx, endIdx);

  return {
    sessionId,
    projectId: found.projectId,
    messages: page,
    total,
    hasMore: startIdx > 0,
  };
}

/**
 * Format ChatMessage[] into a compact text transcript for summarization.
 *
 * Builds backwards from the most recent message so the 12K budget
 * captures the latest activity — the part you actually need to catch up on.
 *
 * User messages: up to 500 chars each.
 * Assistant messages: up to 300 chars with tool/agent names appended.
 * Total output capped at maxChars.
 */
export function buildTranscript(
  messages: ChatMessage[],
  maxChars = TRANSCRIPT_MAX_CHARS
): string | null {
  const lines: string[] = [];
  let totalLen = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.role === "user" ? "User" : "Assistant";
    let line: string;

    if (msg.role === "user") {
      line = msg.content.trim().slice(0, 500);
    } else {
      line = msg.content.trim().slice(0, 300);
      const toolNames = [
        ...(msg.agents?.map(
          (a) => `Agent(${a.subagentType || a.description.slice(0, 20)})`
        ) ?? []),
        ...(msg.tools?.map((t) => t.name) ?? []),
      ];
      if (toolNames.length) {
        line += ` [tools: ${toolNames.join(", ")}]`;
      }
    }

    const formatted = `[${role}] ${line}\n\n`;
    if (totalLen + formatted.length > maxChars) {
      lines.push("[...earlier messages omitted...]\n\n");
      break;
    }

    lines.push(formatted);
    totalLen += formatted.length;
  }

  if (lines.length === 0) return null;
  return lines.reverse().join("");
}

/** Load a session's full message history and format as a compact transcript */
export async function getSessionTranscript(
  sessionId: string,
  projectId?: string,
  maxChars = TRANSCRIPT_MAX_CHARS
): Promise<string | null> {
  const found = await findSessionFile(sessionId, projectId);
  if (!found) return null;

  const lines = await parseJsonlFile(found.filePath);
  const messages = convertToMessages(lines);
  return buildTranscript(messages, maxChars);
}

/**
 * Rename a session by appending a custom-title line to its JSONL file.
 * Compatible with Claude Code's own /title command format.
 */
export async function renameSession(
  sessionId: string,
  title: string,
  projectId?: string
): Promise<boolean> {
  const found = await findSessionFile(sessionId, projectId);
  if (!found) return false;

  const line = JSON.stringify({
    type: "custom-title",
    customTitle: title,
    sessionId,
  });
  await appendFile(found.filePath, "\n" + line + "\n");
  return true;
}
