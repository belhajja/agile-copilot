/** Sprints the dashboard can compare at once (same limit as @agile/dashboards). */
export const MAX_SPRINTS = 10;

/** Adds or removes one sprint; adding past `max` changes nothing. */
export function toggleSprint(selected: readonly string[], id: string, max = MAX_SPRINTS): string[] {
  if (selected.includes(id)) return selected.filter((s) => s !== id);
  return selected.length >= max ? [...selected] : [...selected, id];
}

/** The dashboard URL for a selection: `sprints` set (or removed when empty), others kept. */
export function sprintsHref(pathname: string, search: string, selected: readonly string[]): string {
  const params = new URLSearchParams(search);
  params.delete('error');
  if (selected.length > 0) params.set('sprints', selected.join(','));
  else params.delete('sprints');
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
