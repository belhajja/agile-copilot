/**
 * The Keycloak image the SSO contract test runs and the dev compose starts, pinned by digest.
 * Bump both together (a test ties docker-compose.yml to this value).
 */
export const KEYCLOAK_IMAGE =
  'quay.io/keycloak/keycloak:26.8.0@sha256:b0f60d489d51c5d113390bdf5461d4c06e6051be026c05549f2e1e10ec352bcc';
