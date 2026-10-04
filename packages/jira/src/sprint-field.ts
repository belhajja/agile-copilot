/** A sprint as Data Center's Sprint custom field serialises it (greenhopper `toString()` text). */
export interface GreenhopperSprint {
  id: number;
  rapidViewId: number | null;
  state: 'future' | 'active' | 'closed' | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  activatedDate: string | null;
  /** Empty string when the sprint has no goal (Jira 8+ writes `goal=`). */
  goal: string | null;
}

// Every key Jira has ever written, in any order (Jira 7 puts `goal` after `name`, Jira 8+ after
// `sequence`). Values are free text, so the body is cut at these `,key=` markers, never at commas.
const KEYS = [
  'id',
  'rapidViewId',
  'state',
  'name',
  'startDate',
  'endDate',
  'completeDate',
  'activatedDate',
  'sequence',
  'goal',
  'autoStartStop',
  'synced',
  'incompleteIssuesDestinationId',
] as const;
type Key = (typeof KEYS)[number];

/** `<null>` (and a missing key) means no value. */
const value = (v: string | undefined): string | null =>
  v === undefined || v === '<null>' ? null : v;
const date = (v: string | undefined): string | null => {
  const t = value(v)?.trim();
  return t ? t : null;
};

/**
 * Parses `com.atlassian.greenhopper.service.sprint.Sprint@hex[id=1,rapidViewId=2,state=CLOSED,
 * name=..,startDate=..,...]`. Returns null when the text is not a sprint with a numeric id.
 *
 * Known limitation: a name or goal that itself contains `,<knownKey>=` (e.g. a goal reading
 * "x,state=y") is cut there; Jira gives no escaping to tell it apart. The first occurrence of
 * each key wins, so such text can only truncate the value before it.
 */
export function parseGreenhopperSprint(text: string): GreenhopperSprint | null {
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  if (open < 0 || close <= open) return null;
  const body = text.slice(open + 1, close);

  const markers: { key: Key; at: number; from: number }[] = [];
  for (const key of KEYS) {
    if (body.startsWith(`${key}=`)) markers.push({ key, at: 0, from: key.length + 1 });
    for (let i = body.indexOf(`,${key}=`); i >= 0; i = body.indexOf(`,${key}=`, i + 1)) {
      markers.push({ key, at: i, from: i + key.length + 2 });
    }
  }
  markers.sort((a, b) => a.at - b.at);
  const seen = new Set<Key>();
  const kept = markers.filter((m) => !seen.has(m.key) && seen.add(m.key));
  const raw: Partial<Record<Key, string>> = {};
  kept.forEach((m, i) => {
    raw[m.key] = body.slice(m.from, kept[i + 1]?.at ?? body.length);
  });

  if (kept[0]?.key !== 'id' || !/^\d+$/.test(raw.id ?? '')) return null;
  const state = value(raw.state)?.trim().toLowerCase();
  const view = value(raw.rapidViewId)?.trim();
  return {
    id: Number(raw.id),
    rapidViewId: view && /^\d+$/.test(view) ? Number(view) : null,
    state: state === 'future' || state === 'active' || state === 'closed' ? state : null,
    name: raw.name ?? '',
    startDate: date(raw.startDate),
    endDate: date(raw.endDate),
    completeDate: date(raw.completeDate),
    activatedDate: date(raw.activatedDate),
    goal: value(raw.goal),
  };
}
