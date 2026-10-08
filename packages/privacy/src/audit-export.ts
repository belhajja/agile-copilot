import { can } from '@agile/auth';
import { type Actor, auditLog, type Db, recordAudit, user, withOrg } from '@agile/db';
import { and, asc, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm';
import { type OpenExportResult, openThrottledExport } from './gdpr';

export type AuditExportFormat = 'csv' | 'json';

export class AuditExportError extends Error {
  override name = 'AuditExportError';
  constructor(readonly code: 'forbidden_role') {
    super(code);
  }
}

export interface AuditEntry {
  id: string;
  createdAt: Date;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

/** Rows per database round trip while exporting. */
export const AUDIT_EXPORT_PAGE = 1000;

const COLUMNS = [
  'created_at',
  'action',
  'actor_user_id',
  'actor_name',
  'actor_email',
  'target_type',
  'target_id',
  'metadata',
] as const;

/**
 * One CSV cell (RFC 4180 quoting). Text a spreadsheet would run as a formula (= + - @ after any
 * leading whitespace or quotes, or a leading tab, carriage return or line feed) gets a leading apostrophe: audit metadata can hold text people typed.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s'"]*[=+\-@]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * One JSON Lines record: JSON.stringify never emits a raw newline, and U+2028/U+2029 (valid in
 * JSON, but line breaks to some readers) are escaped too, so one record is always one line.
 */
const jsonLine = (value: unknown): string =>
  JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

const valuesOf = (e: AuditEntry): unknown[] => [
  e.createdAt.toISOString(),
  e.action,
  e.actorUserId,
  e.actorName,
  e.actorEmail,
  e.targetType,
  e.targetId,
  e.metadata,
];

type Row = AuditEntry & { cursorAt: string };

/**
 * One page of entries. The cursor keeps the database's own timestamp text: a JavaScript Date
 * drops microseconds, which would repeat or skip entries at page boundaries.
 */
function selectPage(
  db: Db,
  orgId: string,
  opts: {
    from?: Date;
    to?: Date;
    after?: { at: string; id: string } | null;
    limit: number;
    newestFirst?: boolean;
  },
): Promise<Row[]> {
  const where: (SQL | undefined)[] = [
    eq(auditLog.orgId, orgId),
    opts.from ? gte(auditLog.createdAt, opts.from) : undefined,
    opts.to ? lt(auditLog.createdAt, opts.to) : undefined,
    opts.after
      ? sql`(${auditLog.createdAt}, ${auditLog.id}) > (${opts.after.at}::timestamptz, ${opts.after.id}::uuid)`
      : undefined,
  ];
  const order = opts.newestFirst
    ? [desc(auditLog.createdAt), desc(auditLog.id)]
    : [asc(auditLog.createdAt), asc(auditLog.id)];
  return withOrg(db, orgId, (tx) =>
    tx
      .select({
        id: auditLog.id,
        createdAt: auditLog.createdAt,
        cursorAt: sql<string>`${auditLog.createdAt}::text`,
        actorUserId: auditLog.actorUserId,
        actorName: user.name,
        actorEmail: user.email,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.actorUserId))
      .where(and(...where))
      .orderBy(...order)
      .limit(opts.limit),
  );
}

const assertCanExport = (actor: Actor) => {
  if (!can(actor.roles, 'audit.export')) throw new AuditExportError('forbidden_role');
};

/** The latest entries, newest first (the audit page). Owners and admins only. */
export async function recentAuditEntries(db: Db, actor: Actor, limit = 50): Promise<AuditEntry[]> {
  assertCanExport(actor);
  const rows = await selectPage(db, actor.orgId, { limit, newestFirst: true });
  return rows.map(({ cursorAt: _c, ...e }) => e);
}

/**
 * The workspace's audit log as CSV or JSON Lines, oldest first, produced page by page (keyset on
 * created_at and id, so entries written meanwhile neither repeat nor shift pages). Owners and
 * admins only; the export is itself audited before the first row is read.
 */
export async function exportAuditLog(
  db: Db,
  actor: Actor,
  opts: { format: AuditExportFormat; from?: Date; to?: Date },
): Promise<AsyncGenerator<string>> {
  assertCanExport(actor);
  await withOrg(db, actor.orgId, (tx) =>
    recordAudit(tx, {
      orgId: actor.orgId,
      actorUserId: actor.userId,
      action: 'audit.exported',
      targetType: 'organization',
      targetId: actor.orgId,
      metadata: {
        format: opts.format,
        from: opts.from?.toISOString() ?? null,
        to: opts.to?.toISOString() ?? null,
      },
    }),
  );
  const line = (e: AuditEntry) => {
    const values = valuesOf(e);
    if (opts.format === 'csv') {
      return `${values.map((v, i) => csvCell(i === 7 ? JSON.stringify(v) : v)).join(',')}\r\n`;
    }
    return `${jsonLine(Object.fromEntries(COLUMNS.map((c, i) => [c, values[i]])))}\n`;
  };
  return (async function* () {
    if (opts.format === 'csv') yield `${COLUMNS.join(',')}\r\n`;
    let after: { at: string; id: string } | null = null;
    for (;;) {
      const rows = await selectPage(db, actor.orgId, {
        from: opts.from,
        to: opts.to,
        after,
        limit: AUDIT_EXPORT_PAGE,
      });
      if (rows.length > 0) yield rows.map(line).join('');
      const last = rows.at(-1);
      if (!last || rows.length < AUDIT_EXPORT_PAGE) return;
      after = { at: last.cursorAt, id: last.id };
    }
  })();
}

export type OpenAuditExportResult = OpenExportResult | { ok: false; code: 'forbidden_role' };

/**
 * The route's entry point: the role check, then the throttle (one export running per person, a
 * few per hour, shared mechanism with the personal data export), then `exportAuditLog`.
 */
export async function openAuditExport(
  db: Db,
  actor: Actor,
  opts: { format: AuditExportFormat; from?: Date; to?: Date },
): Promise<OpenAuditExportResult> {
  if (!can(actor.roles, 'audit.export')) return { ok: false, code: 'forbidden_role' };
  return openThrottledExport(db, actor.userId, 'audit', () => exportAuditLog(db, actor, opts));
}
