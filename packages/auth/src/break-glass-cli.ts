/**
 * Creates a break-glass account: `pnpm --filter @agile/auth break-glass:create <email> [name]`.
 * The address must be in BREAK_GLASS_EMAILS. The password is read from stdin (typed without
 * echo on a terminal, or piped), never from the command line.
 */
import { EnvError, parseServerEnv } from '@agile/config';
import { createDb } from '@agile/db';
import { createBreakGlassAccount, NOT_BREAK_GLASS } from './break-glass';
import { createAuth } from './server';
import { isBreakGlass } from './sso';

async function readLine(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.includes('\n')) break;
  }
  // Windows PowerShell pipes text with a UTF-8 byte order mark (and CRLF).
  return data.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? '';
}

/** Reads one line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          done();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          done();
          reject(new Error('CANCELLED'));
          return;
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readLine();
  const first = await readHidden('Password: ');
  const again = await readHidden('Repeat the password: ');
  if (first !== again) throw new Error('PASSWORDS_DIFFER');
  return first;
}

const codeOf = (error: unknown) => {
  const body = (error as { body?: { code?: unknown } }).body;
  if (typeof body?.code === 'string') return body.code;
  if (error instanceof Error && /^[A-Z_]+$/.test(error.message)) return error.message;
  return error instanceof Error ? error.name : 'UnknownError';
};

async function main(): Promise<number> {
  const [email, ...nameParts] = process.argv.slice(2);
  if (!email) {
    console.error('Usage: pnpm --filter @agile/auth break-glass:create <email> [name]');
    return 2;
  }
  let env: ReturnType<typeof parseServerEnv>;
  try {
    env = parseServerEnv();
  } catch (error) {
    console.error(error instanceof EnvError ? error.message : 'Invalid server environment');
    return 1;
  }
  if (!isBreakGlass(email, env.BREAK_GLASS_EMAILS)) {
    console.error(`${NOT_BREAK_GLASS}: add the address to BREAK_GLASS_EMAILS first`);
    return 1;
  }
  const password = await readPassword();
  const conn = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const auth = createAuth({
      db: conn.db,
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      passwordLogin: env.PASSWORD_LOGIN,
      breakGlassEmails: env.BREAK_GLASS_EMAILS,
    });
    const created = await createBreakGlassAccount(auth, env.BREAK_GLASS_EMAILS, {
      email,
      password,
      name: nameParts.join(' ') || 'Break-glass admin',
    });
    console.log(`Created break-glass account ${created.email}`);
    return 0;
  } catch (error) {
    console.error(`Could not create the account: ${codeOf(error)}`);
    return 1;
  } finally {
    await conn.close();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`Could not create the account: ${codeOf(error)}`);
  return 1;
});
