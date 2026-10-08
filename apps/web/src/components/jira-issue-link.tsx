'use client';

import { useTranslations } from 'next-intl';
import { createContext, type ReactNode, useContext } from 'react';
import { jiraBrowseUrl } from '@/lib/jira-link';

const JiraSiteContext = createContext<string | null>(null);
const BoardSitesContext = createContext<Readonly<Record<string, string>>>({});

/** The Jira site (base URL) issue keys below link to. */
export function JiraSiteProvider({
  baseUrl,
  children,
}: {
  baseUrl: string | null | undefined;
  children: ReactNode;
}) {
  return <JiraSiteContext.Provider value={baseUrl ?? null}>{children}</JiraSiteContext.Provider>;
}

/** Board id → its Jira site's base URL, for results that name their board. */
export function BoardSitesProvider({
  sites,
  children,
}: {
  sites: Readonly<Record<string, string>>;
  children: ReactNode;
}) {
  return <BoardSitesContext.Provider value={sites}>{children}</BoardSitesContext.Provider>;
}

export function useBoardSite(boardId: string): string | null {
  const sites = useContext(BoardSitesContext);
  return Object.hasOwn(sites, boardId) ? (sites[boardId] ?? null) : null;
}

/** An issue key, linked to the issue in Jira when the site is known (plain text otherwise). */
export function JiraIssueLink({
  issueKey,
  baseUrl,
}: {
  issueKey: string;
  /** Overrides the site from the provider. */
  baseUrl?: string | null;
}) {
  const t = useTranslations('jira');
  const fromContext = useContext(JiraSiteContext);
  const href = jiraBrowseUrl(baseUrl === undefined ? fromContext : baseUrl, issueKey);
  if (!href) return <>{issueKey}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('openIssue', { key: issueKey })}
      className="underline underline-offset-2 hover:text-primary"
      data-issue-link
    >
      {issueKey}
    </a>
  );
}
