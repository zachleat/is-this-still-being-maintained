import EleventyFetch from "@11ty/eleventy-fetch";

const CACHE_DIR = ".cache";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When true, eleventy-fetch still *reads* the cache but never writes to it, so a
// run touches nothing on disk. Set once at startup by `--dry-run`.
let dryRun = false;
export function setDryRun(value) {
  dryRun = Boolean(value);
}

// eleventy-fetch throws `Bad response for <url> (<status>)` with the failed
// Response (or the underlying network error) attached as `err.cause`.
const statusOf = (err) => err?.cause?.status;

/** True when a thrown eleventy-fetch error was an HTTP 404 (a real "not found"). */
export function is404(err) {
  return statusOf(err) === 404;
}

function retryAfterMs(err) {
  const headers = err?.cause?.headers;
  const seconds = headers?.get ? Number(headers.get("retry-after")) : 0;
  return seconds ? seconds * 1000 : 0;
}

// Retry transient failures only: 429, 5xx, and network errors (no status).
// A 404 (or any other 4xx) is a real answer — surface it immediately.
function isRetryable(err) {
  const status = statusOf(err);
  if (status === undefined) return true; // network/transport error
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Fetch JSON through @11ty/eleventy-fetch, so every request is cached on disk
 * (default 1 hour) and repeat runs don't hit the network. Transient failures
 * are retried with backoff; a 404 rejects (callers catch it via `is404`).
 */
export async function cachedJSON(
  url,
  { fetchOptions, duration = "1h", retries = 5 } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await EleventyFetch(url, {
        type: "json",
        duration,
        directory: CACHE_DIR,
        dryRun,
        fetchOptions,
      });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      const backoff = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(Math.max(backoff, retryAfterMs(err)));
    }
  }
  throw lastErr;
}
