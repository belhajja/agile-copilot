// Shared with the browser (`@agile/agent/limits`): keep this file free of server imports.

/** Longest conversation title kept, typed or derived from the first question. */
export const TITLE_MAX_LENGTH = 80;

/** Longest conversation group name kept. */
export const GROUP_NAME_MAX_LENGTH = 60;

/** Longest chat message the server accepts (characters after trimming). */
export const MESSAGE_MAX_LENGTH = 8_000;
