import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAILPIT_IMAGE } from './testing';

const read = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

describe('Mailpit (development mail catcher)', () => {
  it('runs the image the email contract test uses, on loopback only', () => {
    const dev = read('docker-compose.yml');
    expect([...dev.matchAll(/axllent\/mailpit\S*/g)].map((m) => m[0])).toEqual([MAILPIT_IMAGE]);
    expect(dev).toContain('ports: ["127.0.0.1:1025:1025", "127.0.0.1:8025:8025"]');
    // Self-hosters use their own SMTP server: no mail catcher in production.
    expect(read('docker-compose.selfhost.yml')).not.toContain('mailpit');
  });
});
