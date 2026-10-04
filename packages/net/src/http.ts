/** A 3xx answer was refused: following it could bounce a server-side request to an unchecked host. */
export class RedirectBlockedError extends TypeError {
  override name = 'RedirectBlockedError';
  constructor(readonly status: number) {
    super(`Redirect blocked (HTTP ${status})`);
  }
}

/** The deadline passed first. Named `TimeoutError` like `AbortSignal.timeout()` aborts, so callers map both the same way. */
export class DeadlineExceededError extends Error {
  override name = 'TimeoutError';
  constructor(readonly ms: number) {
    super(`Deadline of ${ms} ms exceeded`);
  }
}

/**
 * `fetch` that never follows redirects. Every outbound call to a user-supplied or token-bearing URL
 * goes through here: a public host must not be able to bounce us (and our credentials) elsewhere.
 */
export const fetchNoRedirect: typeof fetch = async (input, init) => {
  const res = await fetch(input, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new RedirectBlockedError(res.status);
  }
  return res;
};

/**
 * Rejects with `onTimeout()` (default DeadlineExceededError) if `promise` has not settled within
 * `ms`. The timer is always cleared, so a settled promise leaves nothing scheduled behind it.
 * Use it for APIs that take no AbortSignal; the underlying work is not cancelled.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error = () => new DeadlineExceededError(ms),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
