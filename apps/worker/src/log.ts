export type Logger = (
  level: 'info' | 'warn' | 'error',
  event: string,
  fields?: Record<string, string | number | boolean | null>,
) => void;

/** One JSON object per line on stdout/stderr. Only codes and names: never messages or secrets. */
export const log: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === 'info') console.log(line);
  else console.error(line);
};
