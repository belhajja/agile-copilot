// Bundles a Node entry point (TypeScript, workspace packages and npm dependencies) into one ESM
// file for the runtime images: no node_modules, no tsx, no build tools in the final layer.
// Usage: node scripts/bundle-node.mjs <entry.ts> <out.mjs>
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: node scripts/bundle-node.mjs <entry.ts> <out.mjs>');
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // Some dependencies still call require(): give the ESM bundle one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  // pg's optional native binding is never installed.
  external: ['pg-native'],
  minify: true,
  keepNames: true,
  legalComments: 'none',
  logLevel: 'warning',
});
