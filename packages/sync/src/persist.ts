import {
  type BoardColumn,
  jiraBoardIssues,
  jiraBoardSprints,
  jiraBoards,
  jiraIssueChanges,
  jiraIssues,
  jiraIssueTransitions,
  jiraSprintIssues,
  jiraSprints,
  jiraStatusMappings,
  type Tx,
} from '@agile/db';
import {
  type JiraBoardConfig,
  type JiraSprintInfo,
  type JiraStatusInfo,
  type NormalizedIssue,
  suggestStatusMapping,
} from '@agile/jira';
import { and, eq, inArray, sql } from 'drizzle-orm';

const excluded = (column: string) => sql.raw(`excluded.${column}`);

export async function saveBoardConfig(tx: Tx, boardId: string, config: JiraBoardConfig) {
  await tx
    .update(jiraBoards)
    .set({
      filterId: config.filterId,
      estimationFieldId: config.estimationFieldId,
      estimationFieldName: config.estimationFieldName,
      columns: config.columns satisfies BoardColumn[],
    })
    .where(eq(jiraBoards.id, boardId));
}

/** Adds a suggested mapping for every status the board doesn't map yet; existing ones are kept. */
export async function ensureStatusMappings(
  tx: Tx,
  orgId: string,
  boardId: string,
  statusIds: Iterable<string>,
  statuses: Map<string, JiraStatusInfo>,
) {
  const values = [...new Set(statusIds)].map((id) => {
    const status = statuses.get(id) ?? { id, name: id, categoryKey: 'undefined' as const };
    // Statuses Jira doesn't describe (or puts in no category) start as "to do" until a person decides.
    const unknown = status.categoryKey === 'undefined';
    return {
      orgId,
      boardId,
      jiraStatusId: id,
      statusName: status.name,
      jiraCategory: status.categoryKey,
      ...(unknown ? { category: 'todo' as const, blocked: false } : suggestStatusMapping(status)),
      source: 'auto' as const,
    };
  });
  if (values.length > 0) await tx.insert(jiraStatusMappings).values(values).onConflictDoNothing();
}

export async function saveSprints(
  tx: Tx,
  orgId: string,
  connectionId: string,
  boardId: string,
  sprints: JiraSprintInfo[],
) {
  if (sprints.length === 0) return;
  const rows = await tx
    .insert(jiraSprints)
    .values(sprints.map((s) => ({ orgId, connectionId, ...s })))
    .onConflictDoUpdate({
      target: [jiraSprints.connectionId, jiraSprints.jiraSprintId],
      set: {
        name: excluded('name'),
        state: excluded('state'),
        startAt: excluded('start_at'),
        endAt: excluded('end_at'),
        completeAt: excluded('complete_at'),
        goal: excluded('goal'),
        originBoardJiraId: excluded('origin_board_jira_id'),
      },
    })
    .returning({ id: jiraSprints.id });
  await tx
    .insert(jiraBoardSprints)
    .values(rows.map((r) => ({ orgId, boardId, sprintId: r.id })))
    .onConflictDoNothing();
}

/**
 * Upserts one page of issues, links them to the board and replaces their history (the full
 * changelog is re-read whenever an issue changes). Returns the stored issue ids.
 */
export async function saveIssues(
  tx: Tx,
  orgId: string,
  connectionId: string,
  boardId: string,
  issues: NormalizedIssue[],
  syncedAt: Date,
): Promise<string[]> {
  if (issues.length === 0) return [];
  const rows = await tx
    .insert(jiraIssues)
    .values(
      issues.map((i) => ({
        orgId,
        connectionId,
        jiraIssueId: i.jiraIssueId,
        key: i.key,
        summary: i.summary,
        issueType: i.issueType,
        isSubtask: i.isSubtask,
        statusId: i.statusId,
        assigneeId: i.assigneeId,
        assigneeName: i.assigneeName,
        estimate: i.estimate,
        jiraCreatedAt: i.createdAt,
        jiraUpdatedAt: i.updatedAt,
        resolvedAt: i.resolvedAt,
        labels: i.labels,
        components: i.components,
        fixVersions: i.fixVersions,
        priority: i.priority,
        epicKey: i.epicKey,
        epicName: i.epicName,
        syncedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [jiraIssues.connectionId, jiraIssues.jiraIssueId],
      set: {
        key: excluded('key'),
        summary: excluded('summary'),
        issueType: excluded('issue_type'),
        isSubtask: excluded('is_subtask'),
        statusId: excluded('status_id'),
        assigneeId: excluded('assignee_id'),
        assigneeName: excluded('assignee_name'),
        estimate: excluded('estimate'),
        jiraCreatedAt: excluded('jira_created_at'),
        jiraUpdatedAt: excluded('jira_updated_at'),
        resolvedAt: excluded('resolved_at'),
        labels: excluded('labels'),
        components: excluded('components'),
        fixVersions: excluded('fix_versions'),
        priority: excluded('priority'),
        epicKey: excluded('epic_key'),
        epicName: sql`coalesce(excluded.epic_name, case when excluded.epic_key is not distinct from ${jiraIssues.epicKey} then ${jiraIssues.epicName} end)`,
        syncedAt: excluded('synced_at'),
      },
    })
    .returning({ id: jiraIssues.id, jiraIssueId: jiraIssues.jiraIssueId });
  const idOf = new Map(rows.map((r) => [r.jiraIssueId, r.id]));
  const ids = rows.map((r) => r.id);

  await tx
    .insert(jiraBoardIssues)
    .values(ids.map((issueId) => ({ orgId, boardId, issueId })))
    .onConflictDoNothing();
  await tx.delete(jiraIssueTransitions).where(inArray(jiraIssueTransitions.issueId, ids));
  await tx.delete(jiraIssueChanges).where(inArray(jiraIssueChanges.issueId, ids));
  await tx.delete(jiraSprintIssues).where(inArray(jiraSprintIssues.issueId, ids));

  const withId = issues.flatMap((i) => {
    const issueId = idOf.get(i.jiraIssueId);
    return issueId ? [{ issueId, i }] : [];
  });
  const transitions = withId.flatMap(({ issueId, i }) =>
    i.transitions.map((t) => ({ orgId, issueId, ...t })),
  );
  const changes = withId.flatMap(({ issueId, i }) =>
    i.changes.map((c) => ({ orgId, issueId, ...c })),
  );
  const membership = withId.flatMap(({ issueId, i }) =>
    i.sprintMembership.map((m) => ({ orgId, connectionId, issueId, ...m })),
  );
  if (transitions.length > 0) await tx.insert(jiraIssueTransitions).values(transitions);
  if (changes.length > 0) await tx.insert(jiraIssueChanges).values(changes);
  if (membership.length > 0) await tx.insert(jiraSprintIssues).values(membership);
  return ids;
}

/** Epic names looked up after a board's issues are saved (Data Center keeps only the key). */
export async function saveEpicNames(
  tx: Tx,
  connectionId: string,
  names: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [key, name] of names) {
    await tx
      .update(jiraIssues)
      .set({ epicName: name })
      .where(and(eq(jiraIssues.connectionId, connectionId), eq(jiraIssues.epicKey, key)));
  }
}

/** After a full read of a board: unlink issues that no longer match its filter. */
export async function pruneBoardIssues(tx: Tx, boardId: string, keep: string[]) {
  await tx.delete(jiraBoardIssues).where(
    keep.length === 0
      ? eq(jiraBoardIssues.boardId, boardId)
      : and(
          eq(jiraBoardIssues.boardId, boardId),
          // One text parameter however large the board (a uuid list never contains a comma).
          sql`not (${jiraBoardIssues.issueId} = any(string_to_array(${keep.join(',')}, ',')::uuid[]))`,
        ),
  );
}
