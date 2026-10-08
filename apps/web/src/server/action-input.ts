import { UUID_PATTERN } from '@agile/db';
import { z } from 'zod';

/*
 * Server actions are public endpoints: a crafted call sends whatever it likes, whatever the
 * TypeScript signature says. Every action parses each argument it reads before using it.
 */

/** A database id (any uuid version, as the stores check them). */
export const uuid = z.string().regex(UUID_PATTERN);

/** The form a `useActionState` action is posted with. */
export const formData = z.instanceof(FormData);
