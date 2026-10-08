/** A Jira answer never ended: too many pages or items. The message carries no URL. */
export class JiraPaginationLimitError extends Error {
  override name = 'JiraPaginationLimitError';
  constructor() {
    super('Jira returned more pages or items than the sync allows.');
  }
}

/** Jira's paging is inconsistent (a page or token came back twice): the data read so far is unreliable. */
export class JiraPaginationError extends Error {
  override name = 'JiraPaginationError';
  constructor(readonly reason: 'repeated_page' | 'repeated_token') {
    super(`Jira paging is inconsistent (${reason}).`);
  }
}

export interface PaginationLimits {
  maxPages?: number;
  maxItems?: number;
}

const MAX_PAGES = 1000;
const MAX_ITEMS = 200_000;

interface PageMeta {
  isLast?: boolean | undefined;
  total?: number | undefined;
  maxResults?: number | undefined;
}

type Id = string | number | undefined;

/**
 * Keeps the first occurrence of each id across pages (endpoints that post-filter can return
 * overlapping offsets). A non-empty page with nothing new means paging made no progress, e.g.
 * `startAt` is ignored: throw rather than hand back data that looks complete.
 */
function dedupe(
  onNoProgress: () => void = () => {
    throw new JiraPaginationError('repeated_page');
  },
) {
  const seen = new Set<string>();
  return <T>(items: T[], idOf: (item: T) => Id): T[] => {
    const fresh = items.filter((item) => {
      const id = idOf(item);
      if (id === undefined) return true;
      const key = String(id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (items.length > 0 && fresh.length === 0) onNoProgress();
    return fresh;
  };
}

/**
 * Guards one paged read (offset style) against a server that never ends: hard page/item caps
 * (throws), de-duplication by id, and a stop when Jira says it is done. An explicit `isLast: false`
 * always continues (Agile endpoints can return short pages after permission filtering); the
 * short-page heuristic applies only when Jira sends neither `total` nor `isLast`.
 */
export function offsetPager(requested: number, limits: PaginationLimits = {}) {
  const maxPages = limits.maxPages ?? MAX_PAGES;
  const maxItems = limits.maxItems ?? MAX_ITEMS;
  const unique = dedupe();
  let pages = 0;
  let received = 0;
  return {
    /** The items not seen on an earlier page. */
    fresh<T>(items: T[], idOf: (item: T) => Id): T[] {
      const kept = unique(items, idOf);
      received += kept.length;
      return kept;
    },
    /** Counts a page of `count` raw items; true when the read is complete. */
    done(page: PageMeta, count: number): boolean {
      pages++;
      if (pages > maxPages || received > maxItems) throw new JiraPaginationLimitError();
      if (count === 0 || page.isLast === true) return true;
      if (page.total !== undefined) return received >= page.total;
      if (page.isLast === false) return false;
      return count < Math.min(requested, page.maxResults ?? requested);
    },
  };
}

/** Same guard for Cloud's token paging, which also throws when a token comes back twice. */
export function tokenPager(limits: PaginationLimits = {}) {
  const maxPages = limits.maxPages ?? MAX_PAGES;
  const maxItems = limits.maxItems ?? MAX_ITEMS;
  let stalled = false;
  const unique = dedupe(() => {
    stalled = true; // reported by next(), which names a repeated token first
  });
  const seen = new Set<string>();
  let pages = 0;
  let received = 0;
  return {
    fresh<T>(items: T[], idOf: (item: T) => Id): T[] {
      const kept = unique(items, idOf);
      received += kept.length;
      return kept;
    },
    /** Counts a page; returns the next token, or undefined when the read is complete. */
    next(isLast: boolean | undefined, token: string | null | undefined) {
      pages++;
      if (pages > maxPages || received > maxItems) throw new JiraPaginationLimitError();
      if (isLast === true || !token) return undefined;
      if (seen.has(token)) throw new JiraPaginationError('repeated_token');
      if (stalled) throw new JiraPaginationError('repeated_page');
      seen.add(token);
      return token;
    },
  };
}
