import { cachedJSON, is404 } from "./fetch.js";

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point";
const DOWNLOADS_RANGE = "https://api.npmjs.org/downloads/range";
// Earliest day npm serves download data for. Anything before this is absent,
// not zero, so histories are clamped to it.
const NPM_DOWNLOADS_EPOCH = "2015-01-10";
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
 * Registry metadata (publish dates, latest version, maintainers) for one package.
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

  // Every currently-published version's publish date, sorted ascending — the raw
  // material for a release-cadence sparkline.
  const versionDates = Object.keys(meta.versions ?? {})
    .map((v) => meta.time?.[v])
    .filter(Boolean)
    .sort();
  const publishCount = versionDates.length;

  // Direct production dependencies of the *published* version — not the repo's
  // current package.json, which can have drifted since the last release and may
  // carry `file:`/workspace links that never ship to consumers.
  const productionDependencies = Object.keys(
    meta.versions?.[latest]?.dependencies ?? {},
  ).length;

  // npm marks deprecation per-version: `deprecated` holds the message string.
  // Reported only — deliberately not used in scoring or any filtering.
  const npmDeprecated = Boolean(meta.versions?.[latest]?.deprecated);

  return {
    name,
    npmDeprecated,
    description: meta.versions?.[latest]?.description ?? meta.description ?? null,
    productionDependencies,
    latestVersion: latest ?? null,
    lastPublishVersion,
    prerelease: Boolean(lastPublishVersion && lastPublishVersion !== latest),
    firstPublish: meta.time?.created ?? null,
    lastPublish,
    // Publish date + version of the stable `latest` dist-tag (ignores prereleases).
    lastStablePublish: (latest && meta.time?.[latest]) ?? null,
    lastStablePublishVersion: latest ?? null,
    publishCount,
    versionDates,
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

const addMonths = (date, n) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};
const isoDay = (d) => d.toISOString().slice(0, 10);

/**
 * Split [from, to] into consecutive windows under npm's per-request range cap.
 * Two different caps apply: a single-package request allows 18 months, while a
 * BULK (comma-separated) request allows only 365 days — so callers pass a
 * smaller `months` for bulk. The single-package case matters more than it
 * looks: asking for a longer range does NOT error, npm silently clamps the
 * response to the most recent 18 months, so a naive full-history request would
 * quietly return only recent data.
 */
export function rangeWindows(from, to, months = 17) {
  const end = new Date(to);
  const windows = [];
  let start = new Date(from);
  while (start <= end) {
    let stop = addMonths(start, months);
    if (stop > end) stop = end;
    windows.push([isoDay(start), isoDay(stop)]);
    start = new Date(stop);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return windows;
}

// Fold a [{day, downloads}] series into monthly totals on an existing Map.
function addDailyToMonths(target, daily) {
  for (const row of daily ?? []) {
    if (!row?.day) continue;
    const ym = row.day.slice(0, 7);
    target.set(ym, (target.get(ym) ?? 0) + (row.downloads ?? 0));
  }
}

/**
 * Monthly download totals per package, back to each package's first publish —
 * floored at `historyYears` before now (default 1) and at npm's 2015-01-10
 * data epoch, whichever is later.
 *
 * `entries` is [{ name, since }] where `since` is an ISO date (firstPublish) or
 * null for "as far back as npm goes". Returns
 * { months: Map<name, Map<"YYYY-MM", number>>, errors: [{name, message}] }.
 *
 * Request shape mirrors `fetchDownloads`: unscoped names go through the bulk
 * endpoint (128 max), scoped ones must go individually and are paced. Windows
 * that closed before the current month can never change, so they are cached far
 * longer than the caller's duration — only the open window refetches normally.
 */
export async function fetchDownloadHistory(
  entries,
  { duration, closedDuration = "365d", historyYears = 1, now = new Date() } = {},
) {
  const months = new Map(entries.map((e) => [e.name, new Map()]));
  const errors = [];
  const today = isoDay(now);
  const currentYm = today.slice(0, 7);
  // A window is "closed" (immutable) once it ends before the current month.
  const durationFor = ([, stop]) =>
    stop.slice(0, 7) < currentYm ? closedDuration : duration;

  // Earliest day worth requesting: the later of npm's data epoch, the cap on how
  // far back we keep history, and (per package) its first publish. The cap is
  // what keeps a cold run cheap — CI starts cold every time, so unbounded
  // history would mean hundreds of requests for months nobody plots.
  const horizon = addMonths(now, -12 * historyYears);
  const floor = new Date(
    Math.max(new Date(NPM_DOWNLOADS_EPOCH), horizon),
  );
  const startFor = (since) => {
    if (!since) return isoDay(floor);
    const d = new Date(since);
    return isoDay(d > floor ? d : floor);
  };

  const scoped = entries.filter((e) => e.name.startsWith("@"));
  const unscoped = entries.filter((e) => !e.name.startsWith("@"));

  // Unscoped: bulk. Every package shares one full-history window set — packages
  // published later simply return nothing for the early windows, which costs a
  // few empty rows but keeps this to ~8 requests instead of 8 per package.
  if (unscoped.length) {
    // The BULK endpoint caps a range at 365 days — stricter than the 18 months
    // a single-package request allows — and rejects anything longer outright
    // ("exceeded max days of 365 for bulk query"). Hence the narrower windows.
    const full = rangeWindows(startFor(null), today, 11);
    for (const window of full) {
      for (const group of chunk(unscoped, BULK_CHUNK)) {
        const url = `${DOWNLOADS_RANGE}/${window[0]}:${window[1]}/${group
          .map((e) => encodeURIComponent(e.name))
          .join(",")}`;
        try {
          const data = await cachedJSON(url, { duration: durationFor(window) });
          for (const e of group) {
            // Bulk responses key by name; a package with no data is null.
            const series =
              group.length === 1 ? data?.downloads : data?.[e.name]?.downloads;
            addDailyToMonths(months.get(e.name), series);
          }
        } catch (err) {
          for (const e of group) errors.push({ name: e.name, message: err.message });
        }
        await sleep(80);
      }
    }
  }

  // Scoped: the bulk endpoint rejects them ("scoped packages are not currently
  // supported in bulk lookups"), so one request per window per package, paced.
  for (const e of scoped) {
    for (const window of rangeWindows(startFor(e.since), today)) {
      const url = `${DOWNLOADS_RANGE}/${window[0]}:${window[1]}/${encodeURIComponent(e.name)}`;
      try {
        const data = await cachedJSON(url, { duration: durationFor(window) });
        addDailyToMonths(months.get(e.name), data?.downloads);
      } catch (err) {
        if (!is404(err)) errors.push({ name: e.name, message: err.message });
      }
      await sleep(200);
    }
  }

  return { months, errors };
}
