/**
 * UI types — simplified shapes for rendering in Lit components.
 *
 * These mirror gateway/types.ts but are tailored for the frontend:
 * ChatMessage adds `streaming` (client-only state), SessionMessage is
 * simplified, and ToolApprovalEvent wraps the gateway's control_request
 * forwarding. This intentional boundary keeps gateway concerns (JSONL
 * parsing, raw content blocks) out of UI code.
 */

/** A Claude Code project directory (grouped by cwd) */
export interface Project {
  /** Encoded path used as directory name in ~/.claude/projects/ */
  id: string;
  /** Human-readable path, e.g. ~/code/my-project */
  path: string;
  /** Number of sessions in this project */
  sessionCount: number;
  /** Most recent session timestamp */
  lastActive: string | null;
}

/** A single message entry from a session JSONL file */
export interface SessionMessage {
  type: "user" | "assistant" | "file-history-snapshot";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version: string;
  entrypoint: string;
  message: {
    role: "user" | "assistant";
    content: string | MessageContent[];
    model?: string;
  };
  usage?: TokenUsage;
}

export interface MessageContent {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Aggregated session metadata returned by the gateway */
export interface SessionSummary {
  sessionId: string;
  projectId: string;
  projectPath: string;
  cwd: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  model: string;
  version: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  /** First user message as a preview */
  firstPrompt: string;
  /** User-set or auto-generated session title */
  customTitle?: string;
}

/** Overview stats aggregated across all sessions */
export interface OverviewStats {
  totalSessions: number;
  totalProjects: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  sessionsToday: number;
  recentSessions: SessionSummary[];
}

/** A parsed chat message from the gateway */
export interface ChatMessage {
  uuid: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  model?: string;
  /** Extended thinking content (collapsed by default in UI) */
  thinking?: string;
  agents?: AgentBlock[];
  tools?: ToolBlock[];
  /** Client-only: message is still being streamed */
  streaming?: boolean;
}

export interface AgentBlock {
  toolUseId: string;
  description: string;
  subagentType: string;
  prompt: string;
  result?: string;
}

export interface ToolBlock {
  toolUseId: string;
  name: string;
  input?: unknown;
  result?: string;
}

export interface SessionMessagesResult {
  sessionId: string;
  projectId: string;
  messages: ChatMessage[];
  total: number;
  hasMore: boolean;
}

/** Tool approval request forwarded from gateway */
export interface ToolApprovalEvent {
  chatId: string;
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
    description?: string;
    display_name?: string;
  };
}

/** Active tab in the cockpit */
export type CockpitTab = "overview" | "chat" | "usage";

