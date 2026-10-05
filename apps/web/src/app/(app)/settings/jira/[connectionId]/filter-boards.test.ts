import type { BoardView } from '@agile/sync';
import { describe, expect, it } from 'vitest';
import { type BoardFilter, boardTypesIn, filterBoards } from './filter-boards';

const board = (id: string, name: string, type: BoardView['type'], projectKey: string | null) =>
  ({ id, name, type, projectKey }) as BoardView;

const boards = [
  board('1', 'Équipe Paiement', 'scrum', 'PAY'),
  board('2', 'Support flow', 'kanban', 'SUP'),
  board('3', 'Platform sprint', 'scrum', 'PLAT'),
  board('4', 'Roadmap', 'simple', null),
];
const none = new Set<string>();
const all: BoardFilter = { query: '', type: 'all', selectedOnly: false };
const ids = (list: BoardView[]) => list.map((b) => b.id);

describe('filterBoards', () => {
  it('keeps every board when no filter is set', () => {
    expect(ids(filterBoards(boards, all, none))).toEqual(['1', '2', '3', '4']);
  });

  it('matches the query against the board name, ignoring case', () => {
    expect(ids(filterBoards(boards, { ...all, query: 'SPRINT' }, none))).toEqual(['3']);
  });

  it('matches the query against the project key', () => {
    expect(ids(filterBoards(boards, { ...all, query: 'sup' }, none))).toEqual(['2']);
  });

  it('ignores accents on both sides', () => {
    expect(ids(filterBoards(boards, { ...all, query: 'equipe' }, none))).toEqual(['1']);
    expect(ids(filterBoards(boards, { ...all, query: 'plàt' }, none))).toEqual(['3']);
  });

  it('trims the query and treats a blank one as no filter', () => {
    expect(ids(filterBoards(boards, { ...all, query: '  pay ' }, none))).toEqual(['1']);
    expect(ids(filterBoards(boards, { ...all, query: '   ' }, none))).toHaveLength(4);
  });

  it('keeps only boards of the chosen type', () => {
    expect(ids(filterBoards(boards, { ...all, type: 'scrum' }, none))).toEqual(['1', '3']);
  });

  it('keeps only the ticked boards when selectedOnly is on', () => {
    const ticked = new Set(['2', '4']);
    expect(ids(filterBoards(boards, { ...all, selectedOnly: true }, ticked))).toEqual(['2', '4']);
  });

  it('combines every filter', () => {
    const ticked = new Set(['1', '3']);
    const filter: BoardFilter = { query: 'p', type: 'scrum', selectedOnly: true };
    expect(ids(filterBoards(boards, filter, ticked))).toEqual(['1', '3']);
    expect(ids(filterBoards(boards, { ...filter, query: 'plat' }, ticked))).toEqual(['3']);
  });
});

describe('boardTypesIn', () => {
  it('lists the types present, in a fixed order', () => {
    expect(boardTypesIn(boards)).toEqual(['scrum', 'kanban', 'simple']);
    expect(boardTypesIn([boards[1] as BoardView])).toEqual(['kanban']);
  });
});
