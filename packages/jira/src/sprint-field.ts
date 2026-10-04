/** A sprint as Data Center's Sprint custom field serialises it (greenhopper `toString()` text). */
export interface GreenhopperSprint {
  id: number;
  rapidViewId: number | null;
  state: 'future' | 'active' | 'closed' | null;
  name: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
  goal: string | null;
}

// The order Jira writes the keys in. Values are free text (names and goals contain commas,
// brackets, even "id=3"), so each key is searched for in this order, after the previous one,
// instead of splitting the body on commas.
const KEYS = [
  'id',
  'rapidViewId',
  'state',
  'name',
  'startDate',
  'endDate',
  'completeDate',
  'sequence',
  'goal',
] as const;

const text = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t === undefined || t === '' || t === '<null>' ? null : t;
};

/**
 * Parses `com.atlassian.greenhopper.service.sprint.Sprint@hex[id=1,rapidViewId=2,state=CLOSED,
 * name=..,startDate=..,endDate=..,completeDate=..,sequence=..,goal=..]`; `<null>` means missing.
 * Returns null when the text is not a sprint with a numeric id.
 */
export function parseGreenhopperSprint(value: string): GreenhopperSprint | null {
  const open = value.indexOf('[');
  const close = value.lastIndexOf(']');
  if (open < 0 || close <= open) return null;
  const body = value.slice(open + 1, close);

  const found: { key: (typeof KEYS)[number]; marker: number; from: number }[] = [];
  let cursor = 0;
  for (const key of KEYS) {
    const marker = found.length === 0 ? `${key}=` : `,${key}=`;
    const at =
      found.length === 0 ? (body.startsWith(marker) ? 0 : -1) : body.indexOf(marker, cursor);
    if (at < 0) continue;
    found.push({ key, marker: at, from: at + marker.length });
    cursor = at + marker.length;
  }
  const raw: Partial<Record<(typeof KEYS)[number], string>> = {};
  found.forEach((f, i) => {
    raw[f.key] = body.slice(f.from, found[i + 1]?.marker ?? body.length);
  });

  if (found[0]?.key !== 'id' || !/^\d+$/.test(raw.id ?? '')) return null;
  const state = text(raw.state)?.toLowerCase();
  const view = Number(raw.rapidViewId);
  return {
    id: Number(raw.id),
    rapidViewId: Number.isInteger(view) && text(raw.rapidViewId) ? view : null,
    state: state === 'future' || state === 'active' || state === 'closed' ? state : null,
    name: raw.name ?? '',
    startDate: text(raw.startDate),
    endDate: text(raw.endDate),
    completeDate: text(raw.completeDate),
    goal: text(raw.goal),
  };
}
