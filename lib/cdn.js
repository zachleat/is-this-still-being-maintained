import { cachedJSON } from "./fetch.js";

const JSDELIVR_STATS = "https://data.jsdelivr.com/v1/stats/packages/npm";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Monthly jsDelivr CDN hit counts per package.
 *
 * jsDelivr is the only npm CDN with a public stats API — unpkg and esm.sh have
 * no stats endpoint at all (their `/stats` paths just serve the npm package
 * *named* "stats"). No auth, and scoped packages work normally.
 *
 * `period=all` returns the package's entire daily history in ONE request (no
 * 18-month cap or 365-day bulk cap like npm's downloads API), so history depth
 * costs nothing here — the caller decides how much of it to keep.
 *
 * NOTE: this counts CDN *requests* (browser `<script src>` loads), not installs.
 * It is a different signal from npm downloads, not a substitute: build tools
 * score near zero, while old browser libraries can out-rank their npm numbers.
 * Reported only — deliberately not used in scoring.
 *
 * Returns { months: Map<name, Map<"YYYY-MM", number>>, errors: [{name, message}] }.
 */
export async function fetchCdnHistory(names, { duration } = {}) {
  const months = new Map();
  const errors = [];

  for (const name of names) {
    const byMonth = new Map();
    months.set(name, byMonth);
    try {
      // An unknown package is not a 404 here: it returns 200 with an empty
      // `dates` map, which folds to an empty series on its own.
      const data = await cachedJSON(
        `${JSDELIVR_STATS}/${name}?period=all`,
        { duration },
      );
      for (const [day, hits] of Object.entries(data?.hits?.dates ?? {})) {
        const ym = day.slice(0, 7);
        byMonth.set(ym, (byMonth.get(ym) ?? 0) + (hits ?? 0));
      }
    } catch (err) {
      errors.push({ name, message: err.message });
    }
    await sleep(120);
  }

  return { months, errors };
}
