// Lives in @agile/db so @agile/auth can write audit rows too (auth cannot depend on this package).
export { type AuditAction, recordAudit } from '@agile/db';
