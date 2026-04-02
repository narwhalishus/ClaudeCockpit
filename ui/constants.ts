/** Shared UI constants. */

export const MODEL_OPTIONS = [
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
] as const;

/** Timeout for chat.send requests (ms) */
export const CHAT_REQUEST_TIMEOUT_MS = 120_000;
/** Timeout for sessions.summarize requests (ms) */
export const SUMMARY_REQUEST_TIMEOUT_MS = 60_000;
/** Number of messages to load per page in session history */
export const SESSION_PAGE_SIZE = 50;
/** Number of older messages to load when paginating backward */
export const SESSION_OLDER_PAGE_SIZE = 30;
