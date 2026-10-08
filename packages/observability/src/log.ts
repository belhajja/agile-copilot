export type LogLevel = 'info' | 'warn' | 'error';

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: Record<string, string | number | boolean | null>,
) => void;

/** One JSON object per line on stdout/stderr. Only codes and names: never messages or secrets. */
export const log: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === 'info') console.log(line);
  else console.error(line);
};

/** What to log for a caught value: its error name, never its message (it may carry secrets). */
export const errorName = (error: unknown): string =>
  error instanceof Error ? error.name : 'unknown';
