import type { Docker } from './docker';
import type { Prompter } from './settings';
import type { Build } from './stack';

export interface Context {
  dataDir: string;
  /** The compose files and the files they mount, shipped in the image. */
  assetsDir: string;
  build: Build;
  docker: Docker;
  out: (line: string) => void;
  prompt: Prompter;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  healthTimeoutMs: number;
}
