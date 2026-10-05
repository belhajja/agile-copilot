import type { BoardView } from '@agile/sync';

export type BoardType = BoardView['type'];

export interface BoardFilter {
  query: string;
  type: 'all' | BoardType;
  selectedOnly: boolean;
}

const TYPE_ORDER: readonly BoardType[] = ['scrum', 'kanban', 'simple'];

/** Lower case without accents, so "equipe" finds "Équipe". */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

/**
 * The boards to show. Only the view is filtered: `selected` stays the full selection, so a ticked
 * board hidden by the filter is still saved.
 */
export function filterBoards(
  boards: readonly BoardView[],
  filter: BoardFilter,
  selected: ReadonlySet<string>,
): BoardView[] {
  const query = fold(filter.query.trim());
  return boards.filter(
    (b) =>
      (filter.type === 'all' || b.type === filter.type) &&
      (!filter.selectedOnly || selected.has(b.id)) &&
      (!query || fold(b.name).includes(query) || fold(b.projectKey ?? '').includes(query)),
  );
}

/** The board types present, in a fixed order, for the type filter's options. */
export function boardTypesIn(boards: readonly BoardView[]): BoardType[] {
  const present = new Set(boards.map((b) => b.type));
  return TYPE_ORDER.filter((t) => present.has(t));
}
