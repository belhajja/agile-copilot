/** A Jira answer never ended: too many pages or items. The message carries no URL. */
export class JiraPaginationLimitError extends Error {
  override name = 'JiraPaginationLimitError';
  constructor() {
    super('Jira returned more pages or items than the sync allows.');
  }
}

export interface PaginationLimits {
  maxPages?: number;
  maxItems?: number;
}

export const MAX_PAGES = 1000;
export const MAX_ITEMS = 200_000;

interface PageMeta {
  isLast?: boolean | undefined;
  total?: number | undefined;
  maxResults?: number | undefined;
}

/**
 * Guards one paged read (offset style) against a server that never ends: hard page/item caps
 * (throws), and a stop when Jira says it is done, answers an empty or short page without a
 * `total`, or ignores `startAt` (the same first item twice).
 */
export function offsetPager(requested: number, limits: PaginationLimits = {}) {
  const maxPages = limits.maxPages ?? MAX_PAGES;
  const maxItems = limits.maxItems ?? MAX_ITEMS;
  let pages = 0;
  let received = 0;
  let previousFirst: string | undefined;
  return {
    /** True when this page repeats the previous one: drop it and stop. */
    isRepeat(firstId: string | number | undefined): boolean {
      if (firstId === undefined) return false;
      const id = String(firstId);
      const repeat = id === previousFirst;
      previousFirst = id;
      return repeat;
    },
    /** Counts a page of `count` items; true when the read is complete. */
    done(page: PageMeta, count: number): boolean {
      pages++;
      received += count;
      if (pages > maxPages || received > maxItems) throw new JiraPaginationLimitError();
      if (count === 0 || page.isLast === true) return true;
      if (page.total !== undefined) return received >= page.total;
      return count < Math.min(requested, page.maxResults ?? requested);
    },
  };
}

/** Same guard for Cloud's token paging, which also stops when a token comes back twice. */
export function tokenPager(limits: PaginationLimits = {}) {
  const maxPages = limits.maxPages ?? MAX_PAGES;
  const maxItems = limits.maxItems ?? MAX_ITEMS;
  const seen = new Set<string>();
  let pages = 0;
  let received = 0;
  return {
    /** Counts a page; returns the next token, or undefined when the read is complete. */
    next(count: number, isLast: boolean | undefined, token: string | null | undefined) {
      pages++;
      received += count;
      if (pages > maxPages || received > maxItems) throw new JiraPaginationLimitError();
      if (isLast === true || !token || seen.has(token)) return undefined;
      seen.add(token);
      return token;
    },
  };
}
