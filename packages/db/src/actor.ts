/** The signed-in member a service call acts for. */
export interface Actor {
  orgId: string;
  userId: string;
  roles: readonly string[];
}
