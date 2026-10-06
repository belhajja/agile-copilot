import { randomBytes } from 'node:crypto';

export interface Secrets {
  postgresPassword: string;
  appDbPassword: string;
  betterAuthSecret: string;
  encryptionKeys: string;
}

/** The stack's secrets. The database passwords are hex: the compose file uses them in URLs and SQL. */
export function generateSecrets(random: (n: number) => Buffer = randomBytes): Secrets {
  return {
    postgresPassword: random(24).toString('hex'),
    appDbPassword: random(24).toString('hex'),
    betterAuthSecret: random(32).toString('base64'),
    encryptionKeys: `v1:${random(32).toString('base64')}`,
  };
}
