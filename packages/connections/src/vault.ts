import { generateDek, type Keyring, unwrapDek, wrapDek } from '@agile/crypto';
import { orgDataKeys, type Tx } from '@agile/db';
import { eq } from 'drizzle-orm';

/** Returns the org's data-encryption key, creating it on first use (safe under concurrency). */
export async function getOrgDek(tx: Tx, keyring: Keyring, orgId: string): Promise<Buffer> {
  const read = () => tx.select().from(orgDataKeys).where(eq(orgDataKeys.orgId, orgId)).limit(1);
  let [row] = await read();
  if (!row) {
    const wrapped = wrapDek(keyring, orgId, generateDek());
    await tx
      .insert(orgDataKeys)
      .values({ orgId, kekVersion: wrapped.kekVersion, wrappedDek: wrapped.wrapped })
      .onConflictDoNothing();
    [row] = await read();
  }
  if (!row) throw new Error('Could not create the organization data key');
  return unwrapDek(keyring, orgId, { kekVersion: row.kekVersion, wrapped: row.wrappedDek });
}
