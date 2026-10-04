/**
 * Mailpit (SMTP sink with an HTTP API): the dev compose service and the email contract test use
 * this image, pinned by digest. Bump both together.
 */
export const MAILPIT_IMAGE =
  'axllent/mailpit:v1.31.3@sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d';
