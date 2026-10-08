import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Password sign-in attempts (P5-R47) per account and client address, and per account across
 * addresses, counted before the password is checked, so parallel guesses cannot slip past the
 * limit. Rows with `attempts = 0` mark a client address that signed in to the account
 * successfully (`window_started_at` = when). Keys are keyed hashes (never an e-mail or client
 * address), and an attempt at an e-mail with no account counts the same way, so the table says
 * nothing about who has an account. Not tenant data: sign-in happens before any workspace. Rows
 * whose window has passed are deleted as new attempts come in.
 */
export const signInAttempts = pgTable(
  'sign_in_attempts',
  {
    keyHash: text('key_hash').primaryKey(),
    attempts: integer('attempts').notNull(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sign_in_attempts_window_idx').on(t.windowStartedAt)],
);
