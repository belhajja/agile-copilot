// Imported by next.config.ts: keep workspace packages out of this file.

/**
 * Largest chat request body: up to four 5 MiB images as base64 data URLs in JSON (4/3 of their
 * size, about 26.7 MiB) plus the text, with some room. Anything bigger is refused with 413.
 */
export const CHAT_BODY_MAX_BYTES = 28 * 1024 * 1024;

/**
 * proxy.ts makes Next buffer request bodies, by default only their first 10 MB: a bigger chat
 * request would reach the route cut short. A little above the route's own limit, so a body over it
 * still gets its 413.
 */
export const PROXY_BODY_MAX_BYTES = CHAT_BODY_MAX_BYTES + 1024 * 1024;
