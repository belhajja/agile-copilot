import { describe, expect, it } from 'vitest';
import { assertAssignableRole } from './assign';
import { can, canManageConnections, PERMISSIONS, primaryRole, ROLES } from './roles';

describe('role matrix', () => {
  it('gives each role exactly its permissions', () => {
    const table = Object.fromEntries(
      ROLES.map((role) => [
        role,
        Object.keys(PERMISSIONS).filter((p) => can([role], p as keyof typeof PERMISSIONS)),
      ]),
    );
    expect(table).toEqual({
      owner: [
        'connections.manage',
        'members.manage',
        'workspace.settings',
        'audit.export',
        'usage.view_all',
        'billing.manage',
        'workspace.delete',
        'jira.read',
        'jira.write',
        'mcp.token',
      ],
      admin: [
        'connections.manage',
        'members.manage',
        'workspace.settings',
        'audit.export',
        'usage.view_all',
        'jira.read',
        'jira.write',
        'mcp.token',
      ],
      manager: ['jira.read', 'jira.write', 'mcp.token'],
      viewer: ['mcp.token'],
    });
  });

  it('grants nothing to unknown or legacy roles', () => {
    for (const p of Object.keys(PERMISSIONS)) {
      expect(can(['member'], p as keyof typeof PERMISSIONS)).toBe(false);
      expect(can([], p as keyof typeof PERMISSIONS)).toBe(false);
    }
    expect(canManageConnections(['member'])).toBe(false);
    expect(primaryRole(['member'])).toBeNull();
    expect(primaryRole(['viewer', 'admin'])).toBe('admin');
  });

  it('accepts exactly one of the four roles as an assignment', () => {
    expect(assertAssignableRole('manager')).toBe('manager');
    for (const bad of [
      'member',
      'admin,owner',
      '',
      'superuser',
      // Exact match only: better-auth compares untrimmed strings in its owner checks.
      ' owner',
      'owner ',
      ' admin',
      'owner,admin',
      'Owner',
    ]) {
      expect(() => assertAssignableRole(bad)).toThrow(/owner, admin, manager, viewer/);
    }
    for (const bad of [['viewer'], [' owner'], undefined, null, 1]) {
      expect(() => assertAssignableRole(bad)).toThrow(/owner, admin, manager, viewer/);
    }
  });
});
