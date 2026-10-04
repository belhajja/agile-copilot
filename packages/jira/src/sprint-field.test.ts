import { describe, expect, it } from 'vitest';
import { parseSprintField } from './issue-normalize';
import { parseGreenhopperSprint } from './sprint-field';

const gh = (body: string) => `com.atlassian.greenhopper.service.sprint.Sprint@1a2b[${body}]`;

describe('parseGreenhopperSprint', () => {
  it('reads a Jira 8+ string (activatedDate, empty goal, trailing keys)', () => {
    expect(
      parseGreenhopperSprint(
        gh(
          'id=1,rapidViewId=2,state=ACTIVE,name=Sprint 1,startDate=2026-01-05T09:00:00.000Z,endDate=2026-01-19T09:00:00.000Z,completeDate=<null>,activatedDate=2026-01-05T09:00:00.000Z,sequence=1,goal=,autoStartStop=false,synced=false,incompleteIssuesDestinationId=<null>',
        ),
      ),
    ).toMatchObject({
      id: 1,
      name: 'Sprint 1',
      completeDate: null,
      activatedDate: '2026-01-05T09:00:00.000Z',
      goal: '',
    });
  });

  it('reads a Jira 7 string with the goal right after the name', () => {
    expect(
      parseGreenhopperSprint(
        gh(
          'id=3,rapidViewId=1,state=CLOSED,name=Old, sprint,goal=Be fast,startDate=2026-01-05T09:00:00.000Z,endDate=<null>,completeDate=<null>,sequence=3',
        ),
      ),
    ).toMatchObject({ id: 3, name: 'Old, sprint', goal: 'Be fast', endDate: null });
  });

  it('reads every field, mapping <null> dates to null', () => {
    expect(
      parseGreenhopperSprint(
        gh(
          'id=7,rapidViewId=1,state=CLOSED,name=Sprint 7,startDate=2026-08-16T10:00:00.000Z,endDate=2026-08-30T09:00:00.000Z,completeDate=<null>,sequence=7,goal=Ship it',
        ),
      ),
    ).toEqual({
      id: 7,
      rapidViewId: 1,
      state: 'closed',
      name: 'Sprint 7',
      startDate: '2026-08-16T10:00:00.000Z',
      endDate: '2026-08-30T09:00:00.000Z',
      completeDate: null,
      activatedDate: null,
      goal: 'Ship it',
    });
  });

  it('keeps commas and brackets inside the name and the goal', () => {
    const parsed = parseGreenhopperSprint(
      gh(
        'id=9,rapidViewId=2,state=ACTIVE,name=Alpha, Beta [id=3, state=X],startDate=<null>,endDate=<null>,completeDate=<null>,sequence=9,goal=Fix a, b and c',
      ),
    );
    expect(parsed).toMatchObject({
      id: 9,
      state: 'active',
      name: 'Alpha, Beta [id=3, state=X]',
      startDate: null,
      goal: 'Fix a, b and c',
    });
  });

  it('copes with older strings that lack optional keys and rejects garbage', () => {
    expect(parseGreenhopperSprint(gh('id=12,rapidViewId=3,state=FUTURE,name=S12'))).toMatchObject({
      id: 12,
      state: 'future',
      name: 'S12',
      goal: null,
    });
    expect(parseGreenhopperSprint('not a sprint')).toBeNull();
    expect(parseGreenhopperSprint(gh('name=x'))).toBeNull();
  });

  it('feeds parseSprintField even when the name looks like an id', () => {
    expect(
      parseSprintField([gh('id=9,rapidViewId=2,state=ACTIVE,name=X,id=4,sequence=9')]),
    ).toEqual([9]);
  });
});
