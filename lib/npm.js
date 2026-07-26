import { cachedJSON, is404 } from "./fetch.js";

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point";
const BULK_CHUNK = 100; // npm's bulk downloads endpoint caps around 128 packages

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n),
  );

// Normalize npm's `repository` field to "owner/repo" for GitHub sources, so we
// can tell which repo actually publishes a package. Handles the many shapes npm
// allows: git://, git+https://, https://, "github:owner/repo", "owner/repo".
export function parseRepository(repository) {
  if (!repository) return null;
  const raw = typeof repository === "string" ? repository : repository.url;
  if (!raw) return null;

  const gh = raw.match(
    /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?(?:[#/?].*)?$/i,
  );
  if (gh) return `${gh[1]}/${gh[2]}`;

  // Shorthand: "owner/repo" or "github:owner/repo" (no protocol/host).
  if (!raw.includes("://")) {
    const short = raw.replace(/^github:/i, "");
    if (/^[^/]+\/[^/]+$/.test(short)) return short.replace(/\.git$/i, "");
  }
  return null;
}

/**
 * Registry metadata (publish dates, latest version, deprecation) for one package.
 * Returns null when the package genuinely isn't published (registry 404).
 */
export async function registryMetrics(name, duration) {
  let meta;
  try {
    meta = await cachedJSON(`${REGISTRY}/${encodeURIComponent(name)}`, {
      duration,
    });
  } catch (err) {
    if (is404(err)) return null; // not published
    throw err;
  }

  const latest = meta["dist-tags"]?.latest;

  // Most recent publish across ALL versions, prereleases included. A package that
  // ships frequent alphas/betas but rarely promotes to the stable `latest` tag is
  // still actively maintained, so keying off `latest` alone would wrongly read it
  // as stale. `time` maps every version -> ISO publish date (plus created/modified).
  let lastPublish = null;
  let lastPublishVersion = null;
  for (const [version, time] of Object.entries(meta.time || {})) {
    if (version === "created" || version === "modified") continue;
    if (!lastPublish || new Date(time) > new Date(lastPublish)) {
      lastPublish = time;
      lastPublishVersion = version;
    }
  }
  if (!lastPublish) lastPublish = meta.time?.modified ?? null;

  return {
    name,
    description: meta.versions?.[latest]?.description ?? meta.description ?? null,
    latestVersion: latest ?? null,
    lastPublishVersion,
    prerelease: Boolean(lastPublishVersion && lastPublishVersion !== latest),
    firstPublish: meta.time?.created ?? null,
    lastPublish,
    // Publish date + version of the stable `latest` dist-tag (ignores prereleases).
    lastStablePublish: (latest && meta.time?.[latest]) ?? null,
    lastStablePublishVersion: latest ?? null,
    // Current npm maintainers — the authoritative "who owns this package" signal.
    maintainers: (meta.maintainers ?? []).map((m) => m.name).filter(Boolean),
    // The repo npm says this package is published from ("owner/repo" or null).
    repository: parseRepository(meta.repository),
  };
}

async function oneDownload(name, period, duration) {
  try {
    const data = await cachedJSON(
      `${DOWNLOADS_API}/${period}/${encodeURIComponent(name)}`,
      { duration },
    );
    return data?.downloads ?? 0;
  } catch (err) {
    if (is404(err)) return 0; // no downloads recorded
    throw err;
  }
}

/**
 * Download counts for many packages, minimizing requests to the strict
 * downloads API. Unscoped packages are fetched in bulk (~100 per request);
 * scoped packages (which the bulk endpoint doesn't support) are fetched
 * individually but sequentially so we don't get rate-limited.
 *
 * Resilient by design: a single failed request never zeros the whole batch.
 * Failures are collected and reported so a package with a *failed* lookup can
 * be told apart from one with genuinely zero downloads.
 * Returns { counts: Map<name, number>, errors: Array<{name, message}> }.
 */
export async function fetchDownloads(names, period = "last-month", duration) {
  const counts = new Map();
  const errors = [];
  const scoped = names.filter((n) => n.startsWith("@"));
  const unscoped = names.filter((n) => !n.startsWith("@"));

  // Bulk: unscoped names, up to BULK_CHUNK per request. If a whole chunk
  // fails, fall back to fetching its members one at a time before giving up.
  for (const group of chunk(unscoped, BULK_CHUNK)) {
    const url = `${DOWNLOADS_API}/${period}/${group.map(encodeURIComponent).join(",")}`;
    try {
      const data = await cachedJSON(url, { duration });
      if (group.length === 1) {
        // Single-package responses are a flat object, not keyed by name.
        counts.set(group[0], data?.downloads ?? 0);
      } else {
        for (const name of group) counts.set(name, data?.[name]?.downloads ?? 0);
      }
    } catch {
      for (const name of group) {
        try {
          counts.set(name, await oneDownload(name, period, duration));
        } catch (err) {
          errors.push({ name, message: err.message });
        }
        await sleep(80);
      }
    }
  }

  // Scoped: one at a time, gently.
  for (const name of scoped) {
    try {
      counts.set(name, await oneDownload(name, period, duration));
    } catch (err) {
      errors.push({ name, message: err.message });
    }
    await sleep(80);
  }

  return { counts, errors };
}
