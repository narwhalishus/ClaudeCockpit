/** Gateway-wide constants — magic numbers extracted for clarity. */

/** Max time to wait for claude to generate a session title */
export const TITLE_GENERATION_TIMEOUT_MS = 15_000;
/** Max display length for session titles in sidebar */
export const TITLE_MAX_LENGTH = 100;
/** Max dollar budget for title generation (one-shot claude -p) */
export const TITLE_GENERATION_MAX_BUDGET = 0.05;
/** Max dollar budget for session summary generation */
export const SUMMARY_MAX_BUDGET = 0.10;
/** Truncate tool result text attached to tool blocks beyond this length */
export const TOOL_RESULT_TRUNCATE_CHARS = 500;
/** Max chars for the compact transcript fed to the summarization prompt */
export const TRANSCRIPT_MAX_CHARS = 12_000;
/** Truncate agent prompt preview in UI beyond this length */
export const AGENT_PROMPT_PREVIEW_CHARS = 200;
