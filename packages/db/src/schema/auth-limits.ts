import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Password sign-in attempts per account (P5-R47), counted before the password is checked, so
 * parallel guesses cannot slip past the limit; a successful sign-in deletes the row. The key is a
 * keyed hash of the normalised address (never the address), and an attempt at an address with no
 * account counts the same way, so the table says nothing about who has an account. Not tenant
 * data: sign-in happens before any workspace. Rows whose window has passed are deleted as new
 * attempts come in.
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
