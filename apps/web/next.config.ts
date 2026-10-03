import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: [
    '@agile/auth',
    '@agile/config',
    '@agile/connections',
    '@agile/crypto',
    '@agile/db',
    '@agile/jira',
    '@agile/llm',
    '@agile/net',
  ],
  serverExternalPackages: ['postgres'],
};

export default withNextIntl(config);
