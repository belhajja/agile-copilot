import { describe, expect, it } from 'vitest';
import { groupConversations } from './group-conversations';

const at = (iso: string) => new Date(iso);
const conv = (id: string, iso: string) => ({ id, title: id, updatedAt: at(iso) });
// 2026-10-05 14:00 in Paris (UTC+2)
const now = at('2026-10-05T12:00:00Z');
const tz = 'Europe/Paris';
const shape = (groups: { key: string; items: { id: string }[] }[]) =>
  groups.map((g) => [g.key, g.items.map((c) => c.id)]);

describe('groupConversations', () => {
  it('sorts each conversation into its group by calendar day', () => {
    const list = [
      conv('today', '2026-10-05T06:00:00Z'),
      conv('yesterday', '2026-10-04T20:00:00Z'),
      conv('week', '2026-09-29T10:00:00Z'),
      conv('month', '2026-09-10T10:00:00Z'),
      conv('older', '2026-08-01T10:00:00Z'),
    ];
    expect(shape(groupConversations(list, now, tz))).toEqual([
      ['today', ['today']],
      ['yesterday', ['yesterday']],
      ['week', ['week']],
      ['month', ['month']],
      ['older', ['older']],
    ]);
  });

  it('uses the given time zone for the day boundary', () => {
    // 22:30 UTC on the 4th is already the 5th in Paris, still the 4th in New York.
    const late = [conv('late', '2026-10-04T22:30:00Z')];
    expect(shape(groupConversations(late, now, tz))).toEqual([['today', ['late']]]);
    expect(shape(groupConversations(late, now, 'America/New_York'))).toEqual([
      ['yesterday', ['late']],
    ]);
  });

  it('puts exactly 7 days ago in the week and 30 days ago in the month', () => {
    const list = [conv('d7', '2026-09-28T10:00:00Z'), conv('d30', '2026-09-05T10:00:00Z')];
    expect(shape(groupConversations(list, now, tz))).toEqual([
      ['week', ['d7']],
      ['month', ['d30']],
    ]);
  });

  it('keeps the input order inside a group and leaves out empty groups', () => {
    const list = [conv('b', '2026-10-05T09:00:00Z'), conv('a', '2026-10-05T07:00:00Z')];
    expect(shape(groupConversations(list, now, tz))).toEqual([['today', ['b', 'a']]]);
    expect(groupConversations([], now, tz)).toEqual([]);
  });

  it('treats a time ahead of now (clock skew) as today', () => {
    const list = [conv('ahead', '2026-10-06T09:00:00Z')];
    expect(shape(groupConversations(list, now, tz))).toEqual([['today', ['ahead']]]);
  });
});
