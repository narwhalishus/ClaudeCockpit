/** Raw JSONL line from a Claude Code session file */
export interface RawSessionLine {
  type: "user" | "assistant" | "file-history-snapshot" | "system" | "agent-name" | "custom-title" | "last-prompt" | "queue-operation";
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  entrypoint?: string;
  permissionMode?: string;
  gitBranch?: string;
  message?: {
    role: "user" | "assistant";
    content: string | RawContentBlock[];
    model?: string;
    id?: string;
    type?: string;
    stop_reason?: string | null;
    usage?: RawUsage;
  };
  isSidechain?: boolean;
  isSnapshotUpdate?: boolean;
  /** For agent-name type lines */
  agentName?: string;
  /** For system type lines */
  subtype?: string;
  durationMs?: number;
  messageCount?: number;
  /** Links a "user" tool_result back to the assistant tool_use that triggered it */
  sourceToolAssistantUUID?: string;
  /** For custom-title type lines */
  customTitle?: string;
}

export interface RawContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  /** tool_use: tool name */
  name?: string;
  /** tool_use: the tool's unique ID (for matching tool_result) */
  id?: string;
  /** tool_use: input parameters */
  input?: unknown;
  /** tool_result: the tool_use_id this result is for */
  tool_use_id?: string;
  /** tool_result: result content (string or structured) */
  content?: string | unknown;
  /** tool_result: whether the tool errored */
  is_error?: boolean;
  signature?: string;
}

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

/** Aggregated session data served by the API */
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
  firstPrompt: string;
  /** User-set or auto-generated session title */
  customTitle?: string;
}

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

export interface ProjectInfo {
  id: string;
  path: string;
  sessionCount: number;
  lastActive: string | null;
}

/** A parsed message for the chat UI (converted from raw JSONL) */
export interface ChatMessage {
  uuid: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  model?: string;
  /** Extended thinking content (collapsed by default in UI) */
  thinking?: string;
  /** Subagent tool uses within this assistant message */
  agents?: AgentBlock[];
  /** Tool uses (non-agent) within this assistant message */
  tools?: ToolBlock[];
}

export interface AgentBlock {
  toolUseId: string;
  description: string;
  subagentType: string;
  prompt: string;
  /** Result text if completed */
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
  /** Total message count (for pagination) */
  total: number;
  /** Whether there are older messages to load */
  hasMore: boolean;
}
