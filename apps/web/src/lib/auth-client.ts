import { ac, orgRoles } from '@agile/auth/client';
import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Typed with the four workspace roles (owner, admin, manager, viewer).
export const authClient = createAuthClient({
  plugins: [organizationClient({ ac, roles: orgRoles })],
});
