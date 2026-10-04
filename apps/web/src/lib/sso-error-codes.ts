/**
 * Error codes the SSO round trip sends back as `?error=<code>` (better-auth's callback, its state
 * checks, the account-linking rules, and the identity provider's own OAuth errors). The login and
 * account pages explain these; any other value reads as a generic error. Each has a sentence under
 * `auth.errors` (a test ties them to the messages). Plain module: server pages import it too.
 */
export const SSO_ERROR_CODES = [
  'account_not_linked',
  'unable_to_link_account',
  'email_does_not_match',
  'account_already_linked_to_different_user',
  'email_not_found',
  'email_not_verified',
  'signup_disabled',
  'unable_to_create_user',
  'unable_to_create_session',
  'oauth_provider_not_found',
  'state_mismatch',
  'state_not_found',
  'invalid_callback_request',
  'no_code',
  'invalid_code',
  'issuer_missing',
  'issuer_mismatch',
  'nonce_binding_missing',
  'unable_to_get_user_info',
  'no_callback_url',
  'internal_server_error',
  'access_denied',
  'login_required',
  'temporarily_unavailable',
  'server_error',
  'invalid_request',
] as const;

/** Why an invitation link cannot be shown, explained on the invitation page. */
export const INVITATION_PAGE_ERRORS = [
  'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
  'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION',
  'INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION',
] as const;
