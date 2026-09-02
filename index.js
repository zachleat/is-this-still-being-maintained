#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";

import { discoverRepos, fetchFilesAcrossRepos } from "./lib/github.js";
import { auditPackages } from "./lib/audit.js";
import { setDryRun } from "./lib/fetch.js";
import {
  registryMetrics,
  fetchDownloads,
  fetchDownloadHistory,
} from "./lib/npm.js";
import { scoreProject } from "./lib/score.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- arg parsing (node:util) ----------------------------------------------
function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      json: { type: "string" },
      limit: { type: "string" }, // parseArgs doesn't coerce; Number() below
      color: { type: "boolean" }, // --no-color sets false (allowNegative)
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowNegative: true,
  });
  return {
    ...values,
    limit: values.limit === undefined ? undefined : Number(values.limit),
  };
}

const HELP = `is-this-still-being-maintained — score your OSS packages by maintenance need

Usage: node index.js [options]

Options:
  --config <path>   Config file (default: ./config.json)
  --json <path>     Write full results as JSON (default: ./docs/report.json)
  --limit <n>       Only print the top N rows to the table
  --dry-run         Print the table only — write nothing to disk (no JSON, no cache)
  --no-color        Disable ANSI colors
  -h, --help        Show this help

Requires a GitHub token via \`gh auth login\`, or GITHUB_TOKEN / GH_TOKEN.`;

// --- concurrency-limited map ----------------------------------------------
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// --- output ----------------------------------------------------------------
const useColor = (on) => (code, s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

function scoreColor(score) {
  if (score >= 60) return "31"; // red
  if (score >= 30) return "33"; // yellow
  return "32"; // green
}

function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtDate(iso) {
  return iso ? iso.slice(0, 10) : "—";
}

function renderTable(rows, color, limit) {
  const c = useColor(color);
  const shown = limit ? rows.slice(0, limit) : rows;

  const cols = [
    { h: "Score", w: 6, get: (r) => r.score.toFixed(1), align: "right" },
    { h: "Package", w: 32, get: (r) => r.packageName || r.nameWithOwner },
    { h: "Owner", w: 10, get: (r) => r.owner },
    { h: "Downloads", w: 10, get: (r) => fmtCount(r.downloads), align: "right" },
    { h: "Stars", w: 6, get: (r) => fmtCount(r.stars), align: "right" },
    { h: "Last publish", w: 12, get: (r) => fmtDate(r.lastPublish) },
    { h: "Issues", w: 6, get: (r) => String(r.openIssues), align: "right" },
    { h: "PRs", w: 4, get: (r) => String(r.openPRs), align: "right" },
    {
      h: "Vulns",
      w: 5,
      get: (r) =>
        r.openVulnerabilities === null ? "—" : String(r.openVulnerabilities),
      align: "right",
    },
  ];

  const pad = (s, w, align) => {
    if (s.length > w) s = s.slice(0, w - 1) + "…";
    return align === "right" ? s.padStart(w) : s.padEnd(w);
  };

  const header = cols.map((col) => pad(col.h, col.w, col.align)).join("  ");
  console.log(c("1", header));
  console.log(c("2", "-".repeat(header.length)));

  for (const r of shown) {
    const line = cols
      .map((col) => {
        const cell = pad(col.get(r), col.w, col.align);
        if (col.h === "Score") return c(scoreColor(r.score), cell);
        if (col.h === "Vulns" && r.openVulnerabilities > 0)
          return c("31", cell); // red — an open security problem
        return cell;
      })
      .join("  ");
    console.log(line);
  }

  if (limit && rows.length > limit) {
    console.log(c("2", `\n… and ${rows.length - limit} more (see JSON report)`));
  }
}

// Pick the one "source" entry for each npm package name, returning a Set of the
// winning entry objects (compared by reference, so a workspace monorepo whose
// members all share one nameWithOwner still resolves per-package). The dedup
// exists only to collapse duplicates — many repos generated from a template
// (e.g. eleventy-base-blog) share a package.json name. Rules:
//   - a package claimed by a SINGLE entry is always kept. npm's `repository`
//     field often lags a GitHub rename (e.g. 11ty/eleventy-img -> 11ty/image),
//     so a mismatch there must not drop the only repo that publishes it;
//   - when SEVERAL repos claim the same name, prefer the one npm names in its
//     `repository` field; if none match, keep the most-starred as canonical.
function selectSourceRepos(withMeta) {
  const groups = new Map(); // packageName -> [entry]
  for (const entry of withMeta) {
    if (!entry.meta) continue; // unpublished / errored — nothing to attribute
    const key = entry.repo.packageName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const winners = new Set();
  for (const entries of groups.values()) {
    let winner;
    if (entries.length === 1) {
      winner = entries[0];
    } else {
      const repoUrl = entries[0].meta.repository?.toLowerCase();
      winner =
        (repoUrl &&
          entries.find(
            (e) => e.repo.nameWithOwner.toLowerCase() === repoUrl,
          )) ||
        [...entries].sort((a, b) => b.repo.stars - a.repo.stars)[0];
    }
    winners.add(winner);
  }
  return winners;
}

// Bucket sorted ISO publish dates into a dense per-month release count series,
// from the first month to the last — the numbers you feed a sparkline.
function monthlyReleaseCounts(sortedDates) {
  if (!sortedDates.length) return { start: null, counts: [] };
  const ym = (d) => d.slice(0, 7); // "YYYY-MM"
  const idx = (s) => {
    const [y, m] = s.split("-").map(Number);
    return y * 12 + (m - 1);
  };
  const start = ym(sortedDates[0]);
  const startIdx = idx(start);
  const endIdx = idx(ym(sortedDates[sortedDates.length - 1]));
  const counts = new Array(endIdx - startIdx + 1).fill(0);
  for (const d of sortedDates) counts[idx(ym(d)) - startIdx]++;
  return { start, counts };
}

// Dense monthly series from a Map<"YYYY-MM", total>, running to `lastYm`.
// Ends at the last COMPLETE month on purpose: the current month is always
// partial, so including it would render as a misleading final dip — and it also
// keeps the committed file stable until a month actually rolls over.
function denseMonthly(byMonth, lastYm) {
  const idx = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    return y * 12 + (m - 1);
  };
  const keys = [...byMonth.keys()].filter((k) => k <= lastYm).sort();
  if (!keys.length) return { start: null, counts: [] };
  const startIdx = idx(keys[0]);
  const counts = new Array(idx(lastYm) - startIdx + 1).fill(0);
  for (const k of keys) counts[idx(k) - startIdx] = byMonth.get(k);
  return { start: keys[0], counts };
}

// --- main ------------------------------------------------------------------
async function main() {
  const args = parseCliArgs();
  if (args.help) {
    console.log(HELP);
    return;
  }

  const color = args.color !== false && process.stdout.isTTY;
  const c = useColor(color);

  // --dry-run: print the report but leave the filesystem untouched — no JSON
  // output and no cache writes (the cache is still *read*, so it's still fast).
  const skipWrite = Boolean(args["dry-run"]);
  setDryRun(skipWrite);

  const configPath = path.resolve(args.config || path.join(__dirname, "config.json"));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const {
    githubUsers = [],
    githubOrgs = [],
    npmMaintainers = [],
    monitor = [],
    exclude = [],
    alwaysInclude = [],
    alwaysIncludePackages = [],
    options = {},
    scoring,
  } = config;

  const monitorSet = new Set(monitor);
  const excludeSet = new Set(exclude);
  const keepSet = new Set(alwaysInclude); // by "owner/repo"
  const pkgKeepSet = new Set(alwaysIncludePackages); // by npm package name
  // npm usernames that count as "yours". When set, a package is only attributed
  // to you if one of these is a current maintainer — so a repo that shares a name
  // with someone else's npm package (e.g. eleventy-base-blog) isn't misattributed.
  const ownerSet = new Set(npmMaintainers.map((s) => s.toLowerCase()));
  const isOwned = (meta) =>
    ownerSet.size === 0 ||
    (meta?.maintainers ?? []).some((m) => ownerSet.has(m.toLowerCase()));

  const cacheDuration = options.cacheDuration || "1h";

  console.error(
    c("2", `Discovering repos for ${[...githubUsers, ...githubOrgs].join(", ")}…`),
  );
  const repos = await discoverRepos(githubUsers, githubOrgs, {
    duration: cacheDuration,
  });

  // Filter down to the things worth scoring. `exclude` always wins;
  // `alwaysInclude` then forces a repo through, bypassing the automatic filters
  // below (archived, private package.json, monitor allowlist, no package.json).
  const candidates = repos.filter((r) => {
    if (excludeSet.has(r.nameWithOwner)) return false;
    if (keepSet.has(r.nameWithOwner)) return true;
    if (r.packageName && pkgKeepSet.has(r.packageName)) return true;
    // Archived repos are kept (and flagged `isArchived`) so their npm publishing
    // and download stats still count — archiving retires the repo, not the package.
    if (r.isFork || r.isPrivate || r.isDisabled) return false;
    // A `"private": true` package.json normally drops the entry, but a GitHub
    // template repo is worth tracking on its own GitHub signals — and declaring
    // `workspaces` conventionally makes the root private. Workspace members
    // never carry `isTemplate`, so private members are still filtered here.
    if (r.isPrivatePackage && !r.isTemplate) return false;
    if (monitorSet.size > 0 && !monitorSet.has(r.nameWithOwner)) return false;
    // Template repos are worth tracking even without a package.json / npm release.
    if (!r.packageName && !options.includeReposWithoutPackageJson && !r.isTemplate)
      return false;
    return true;
  });

  // Warn about allowlist entries that matched nothing (typo catcher).
  const discoveredNames = new Set(repos.map((r) => r.nameWithOwner));
  for (const name of keepSet) {
    if (!discoveredNames.has(name)) {
      console.error(
        c("33", `alwaysInclude: "${name}" matched no discovered repo`),
      );
    }
  }
  const discoveredPackages = new Set(
    repos.map((r) => r.packageName).filter(Boolean),
  );
  for (const name of pkgKeepSet) {
    if (!discoveredPackages.has(name)) {
      console.error(
        c("33", `alwaysIncludePackages: "${name}" matched no discovered package`),
      );
    }
  }

  const period = options.downloadsPeriod || "last-month";

  // Phase 1: registry metadata (publish dates) — one request per package,
  // concurrent, since the registry CDN tolerates it.
  console.error(
    c("2", `Fetching npm publish info for ${candidates.length} package(s)…`),
  );
  const withMeta = await mapPool(
    candidates,
    options.concurrency || 8,
    async (repo) => {
      if (!repo.packageName) return { repo, meta: null, error: null };
      try {
        const meta = await registryMetrics(repo.packageName, cacheDuration);
        return { repo, meta, error: null };
      } catch (err) {
        return { repo, meta: null, error: err.message };
      }
    },
  );

  // Resolve which entry is the canonical source for each package name (dedup).
  // An entry counts as a source if it won its package's group, or if its repo is
  // allowlisted (force-included, so dedup can't drop it).
  const winners = selectSourceRepos(withMeta);
  const isSource = (entry) =>
    winners.has(entry) ||
    keepSet.has(entry.repo.nameWithOwner) ||
    pkgKeepSet.has(entry.repo.packageName);

  const publishedEntries = withMeta.filter(
    (x) => x.meta && isSource(x) && isOwned(x.meta),
  );
  const publishedNames = publishedEntries.map((x) => x.repo.packageName);

  // Security: audit each published package's resolved dependency tree for known
  // vulnerabilities (deps.dev + OSV.dev — no auth required). This measures what
  // consumers actually install, so devDependencies are excluded by construction.
  const auditTargets = publishedEntries
    .filter((x) => x.meta.latestVersion)
    .map((x) => ({ name: x.repo.packageName, version: x.meta.latestVersion }));
  console.error(
    c("2", `Auditing dependencies for ${auditTargets.length} published package(s)…`),
  );
  const vulnByPackage = await auditPackages(auditTargets, {
    duration: cacheDuration,
    concurrency: options.concurrency || 8,
  });

  // Phase 2: download counts — one bulk pass for every published package, so we
  // don't hammer (and get throttled by) the strict downloads API.
  console.error(
    c("2", `Fetching npm downloads for ${publishedNames.length} published package(s)…`),
  );
  const { counts: downloads, errors: downloadErrors } = await fetchDownloads(
    publishedNames,
    period,
    cacheDuration,
  );
  const downloadErrorNames = new Map(
    downloadErrors.map((e) => [e.name, e.message]),
  );

  // Load the previous report up front: it carries forward per-package score
  // history, and — when a downloads lookup fails — the last known download count,
  // so a transient npm error doesn't overwrite a real number with 0. Reading it
  // before scoring means the carried-forward value also feeds `importance`.
  const outputDir = options.outputDir || "docs";
  // path.resolve (not join) so an absolute `outputDir` is honored rather than
  // being appended to the cwd.
  const jsonPath = args.json
    ? path.resolve(args.json)
    : path.resolve(outputDir, "report.json");
  let prevReport = null;
  try {
    prevReport = JSON.parse(await readFile(jsonPath, "utf8"));
  } catch {
    /* no prior report — histories and download fallbacks start fresh */
  }
  const prevByName = new Map(
    (prevReport?.projects ?? [])
      .filter((p) => p.packageName)
      .map((p) => [p.packageName, p]),
  );

  // Web-component heuristic: fetch each package's `main` entry file (from
  // package.json, defaulting to index.js) and look for a `customElements`
  // reference. Batched across repos so this is a few requests, not one per package.
  const wcRequests = [];
  for (const { repo } of withMeta) {
    const pkg = repo.packageJson;
    if (!repo.packageName || !pkg) continue;
    const main = String(pkg.main || "index.js").replace(/^\.\//, "");
    const path = repo.workspacePath ? `${repo.workspacePath}/${main}` : main;
    wcRequests.push({ key: repo, repo: repo.nameWithOwner, path });
  }
  const mainFileTexts = wcRequests.length
    ? await fetchFilesAcrossRepos(wcRequests, { duration: cacheDuration })
    : new Map();
  const isWebComponent = (repo) => {
    const text = mainFileTexts.get(repo);
    return text ? /customElements/.test(text) : false;
  };

  const projects = withMeta.map((entry) => {
    const { repo, meta, error } = entry;
    const source = meta ? isSource(entry) : false;
    const owned = isOwned(meta);
    const downloadError =
      meta && source && owned
        ? downloadErrorNames.get(repo.packageName)
        : null;
    // Freshly fetched count, and the previous report's value as a fallback for
    // when this run's lookup failed (same period only — a different
    // `downloadsPeriod` isn't comparable).
    const freshDownloads = downloadError
      ? null
      : downloads.get(repo.packageName) ?? null;
    const prevProject = prevByName.get(repo.packageName);
    const staleDownloads =
      prevProject?.downloadsPeriod === period ? prevProject.downloads : null;
    const npmStatus = error
      ? "error"
      : meta
        ? !source
          ? "not-source"
          : !owned
            ? "not-owned"
            : downloadError
              ? "downloads-error"
              : "published"
        : repo.packageName
          ? "unpublished"
          : "no-package";

    // Only surface npm-derived fields when the package is genuinely this repo's
    // (published + owned + the source). Otherwise (e.g. a template repo that
    // shares a name with someone else's package) `npm` is null and the project
    // is scored on GitHub activity alone.
    const published = Boolean(meta) && source && owned;
    const npm = published ? meta : null;

    const project = {
      nameWithOwner: repo.nameWithOwner,
      owner: repo.nameWithOwner.split("/")[0],
      url: repo.url,
      homepageUrl: repo.homepageUrl || null,
      workspacePath: repo.workspacePath || null,
      packageName: repo.packageName || null,
      isArchived: repo.isArchived,
      isPinned: repo.isPinned,
      isTemplate: repo.isTemplate,
      isWebComponent: isWebComponent(repo),
      // npm's description when published; otherwise fall back to the GitHub repo
      // description, so templates and unpublished repos still get one.
      description: npm?.description || repo.description || null,
      sourceRepo: npm?.repository || null,
      stars: repo.stars,
      openIssues: repo.openIssues,
      closedIssues: repo.closedIssues,
      openPRs: repo.openPRs,
      mergedPRs: repo.mergedPRs,
      closedPRs: repo.closedPRs,
      // Known-vulnerable dependencies in the published package's resolved tree.
      // Only meaningful for actual npm packages, so templates / unpublished
      // repos / docs sites report null.
      openVulnerabilities: published
        ? vulnByPackage.get(repo.packageName)?.vulnerabilities ?? null
        : null,
      // Production dependency weight (devDependencies excluded): the count
      // declared in package.json, and the full resolved transitive tree.
      // Reported only — deliberately not part of the score.
      productionDependencies: npm?.productionDependencies ?? null,
      transitiveDependencies: published
        ? vulnByPackage.get(repo.packageName)?.transitiveDependencies ?? null
        : null,
      repoCreatedAt: repo.repoCreatedAt || null,
      pushedAt: repo.pushedAt,
      lastPublish: npm?.lastPublish || null,
      lastPublishVersion: npm?.lastPublishVersion || null,
      lastStablePublish: npm?.lastStablePublish || null,
      lastStablePublishVersion: npm?.lastStablePublishVersion || null,
      firstPublish: npm?.firstPublish || null,
      latestVersion: npm?.latestVersion || null,
      npmDeprecated: npm?.npmDeprecated ?? null,
      publishCount: npm?.publishCount ?? null,
      prerelease: npm?.prerelease || false,
      // On a failed lookup keep the previous report's number rather than
      // overwriting a real value with 0 (which would also deflate `importance`).
      // `downloadsKnown: false` marks it as carried forward, not freshly fetched.
      downloads: published ? freshDownloads ?? staleDownloads ?? 0 : 0,
      downloadsKnown: published && !downloadError,
      downloadsPeriod: period,
      published,
      npmStatus,
      npmError: error || (downloadError ? `downloads: ${downloadError}` : null),
    };

    const { score, breakdown } = scoreProject(project, scoring);
    return { ...project, score, breakdown };
  });

  projects.sort((a, b) => b.score - a.score);

  // Status summary is computed over *everything* discovered, so excluded
  // packages are still accounted for.
  const tally = projects.reduce((m, p) => {
    m[p.npmStatus] = (m[p.npmStatus] || 0) + 1;
    return m;
  }, {});

  // By default only report packages actually published to npm; a repo with a
  // package.json but no npm release (demos, starters) is dropped. Note that
  // "downloads-error" packages ARE published, so they're kept.
  const publishedOnly = options.publishedOnly !== false;
  const reported = publishedOnly
    ? projects.filter(
        (p) =>
          p.published ||
          p.isTemplate ||
          keepSet.has(p.nameWithOwner) ||
          pkgKeepSet.has(p.packageName),
      )
    : projects;

  // Table -> stdout, worst-first by score.
  renderTable(reported, color, args.limit);

  // JSON -> file, sorted alphabetically so it's stable to commit to source
  // control: each package keeps the same line across runs, and diffs show real
  // metric changes rather than churn from shifting score ranks.
  const sorted = [...reported].sort((a, b) =>
    (a.packageName || a.nameWithOwner).localeCompare(
      b.packageName || b.nameWithOwner,
      "en",
      { sensitivity: "base" },
    ),
  );
  const generatedAt = new Date().toISOString();

  // Cumulative Health Rating (0–100, higher = better maintained): the plain mean
  // of per-package health (100 − score), counting every package equally.
  // Deliberately NOT download-weighted — npm downloads are power-law distributed,
  // so a handful of mega-packages would own the score and a long tail of
  // abandoned packages would barely register. Each package's own `score` already
  // scales by importance, so popularity is still represented.
  const healthRaw = sorted.length
    ? sorted.reduce((sum, p) => sum + (100 - p.score), 0) / sorted.length
    : 100;
  const healthRating = Math.round(healthRaw * 10) / 10;

  // Per-package neglect-score history, from the previous report loaded earlier:
  // keep the last 10 scores. If that report was generated on the same calendar
  // day, replace its newest entry (so same-day reruns don't pile up); else append.
  const prevHistory = new Map();
  let prevHealthHistory = [];
  let sameDay = false;
  {
    const prev = prevReport;
    if (prev) {
      sameDay = prev.generatedAt?.slice(0, 10) === generatedAt.slice(0, 10);
      if (Array.isArray(prev.healthRatingHistory)) {
        prevHealthHistory = prev.healthRatingHistory;
      }
      for (const p of prev.projects || []) {
        if (p.packageName && Array.isArray(p.scoreHistory)) {
          prevHistory.set(p.packageName, p.scoreHistory);
        }
      }
    }
  }
  const appendOrReplace = (history, value) => {
    const next = [...history];
    if (sameDay && next.length) next[next.length - 1] = value;
    else next.push(value);
    return next.slice(-10);
  };
  for (const p of sorted) {
    p.scoreHistory = appendOrReplace(prevHistory.get(p.packageName) || [], p.score);
  }
  const healthRatingHistory = appendOrReplace(prevHealthHistory, healthRating);

  const report = {
    generatedAt,
    healthRating,
    healthRatingHistory,
    config: { githubUsers, githubOrgs, scoring, publishedOnly },
    count: sorted.length,
    projects: sorted,
  };
  if (!skipWrite) {
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");
  }

  // Companion files: npm release timelines for sparklines.
  const metaByName = new Map();
  for (const { repo, meta } of withMeta) {
    if (meta?.versionDates?.length) metaByName.set(repo.packageName, meta);
  }

  // 1. Per-package — an object keyed by package name (alphabetical, since
  // `sorted` is), each a ready-to-render monthly release count series.
  const sparkEntries = sorted.filter(
    (p) => p.published && metaByName.has(p.packageName),
  );
  // Monthly download history, back to each package's first publish. Costs a few
  // hundred requests on a cold cache (scoped names can't be bulked), but closed
  // windows are cached for a year, so normal runs refetch only the open one.
  console.error(
    c("2", `Fetching download history for ${sparkEntries.length} packages…`),
  );
  const { months: downloadMonths, errors: historyErrors } =
    await fetchDownloadHistory(
      sparkEntries.map((p) => ({ name: p.packageName, since: p.firstPublish })),
      { duration: cacheDuration },
    );
  if (historyErrors.length) {
    console.error(
      c("33", `Download history failed for ${historyErrors.length} package(s)`),
    );
  }
  // Last complete month — see denseMonthly.
  const lastCompleteYm = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 1);
    return d.toISOString().slice(0, 7);
  })();

  const sparkPackages = {};
  for (const p of sparkEntries) {
    const dates = metaByName.get(p.packageName).versionDates;
    sparkPackages[p.packageName] = {
      publishCount: dates.length,
      firstPublish: p.firstPublish,
      lastPublish: p.lastPublish,
      monthlyReleases: monthlyReleaseCounts(dates),
      monthlyDownloads: denseMonthly(
        downloadMonths.get(p.packageName) ?? new Map(),
        lastCompleteYm,
      ),
    };
  }
  // No generatedAt in the sparkline files: they should only change (and be
  // committed) when the underlying release data does, not on every run's clock.
  const sparkPath = path.join(path.dirname(jsonPath), "report-sparklines.json");
  if (!skipWrite) {
    await writeFile(
      sparkPath,
      JSON.stringify({ count: sparkEntries.length, packages: sparkPackages }, null, 2) + "\n",
    );
  }

  // 2. Aggregate — a single combined timeline: total releases per month across
  // every published package.
  const allDates = sparkEntries
    .flatMap((p) => metaByName.get(p.packageName).versionDates)
    .sort();
  const allDownloadMonths = new Map();
  for (const p of sparkEntries) {
    for (const [ym, n] of downloadMonths.get(p.packageName) ?? []) {
      allDownloadMonths.set(ym, (allDownloadMonths.get(ym) ?? 0) + n);
    }
  }
  const aggregate = {
    packages: sparkEntries.length,
    publishCount: allDates.length,
    monthlyReleases: monthlyReleaseCounts(allDates),
    monthlyDownloads: denseMonthly(allDownloadMonths, lastCompleteYm),
  };
  const aggregatePath = path.join(
    path.dirname(jsonPath),
    "report-sparkline-aggregate.json",
  );
  if (!skipWrite) {
    await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2) + "\n");
  }
  const parts = [
    tally.published && `${tally.published} published`,
    tally.unpublished && `${tally.unpublished} not on npm`,
    tally["not-source"] &&
      `${tally["not-source"]} package.json copies (not the npm source)`,
    tally["no-package"] && `${tally["no-package"]} without package.json`,
    tally["downloads-error"] &&
      c("33", `${tally["downloads-error"]} missing downloads`),
    tally.error && c("31", `${tally.error} lookup errors`),
  ].filter(Boolean);
  const scope = publishedOnly
    ? `showing ${reported.length} published of ${projects.length} discovered`
    : `${projects.length} projects`;
  console.error(c("2", `\n${scope} (${parts.join(", ")})`));

  // Cumulative Health Rating headline.
  const healthColor =
    healthRating >= 70 ? "32" : healthRating >= 40 ? "33" : "31";
  console.error(
    c("1", "\nHealth Rating: ") +
      c(healthColor, `${healthRating.toFixed(1)} / 100`) +
      c("2", ` — average health of ${sorted.length} packages (higher is better)`),
  );

  // List the shortnames of every discovered repo left out of the report, grouped
  // by why, so exclusions are auditable (spot a repo that shouldn't be missing).
  const excluded = projects.filter((p) => !reported.includes(p));
  if (excluded.length) {
    const reasonLabels = {
      unpublished: "not on npm",
      "not-source": "package.json copy (not the npm source)",
      "not-owned": "npm package owned by someone else",
      "no-package": "no package.json",
      error: "npm lookup error",
    };
    const maintainersByRepo = new Map(
      withMeta.map((x) => [x.repo.nameWithOwner, x.meta?.maintainers ?? []]),
    );
    const byReason = new Map();
    for (const p of excluded) {
      // Workspace members share their parent's repo name, so include the path to
      // keep them distinguishable instead of rendering as duplicate lines.
      let label = p.workspacePath
        ? `${p.nameWithOwner}/${p.workspacePath}`
        : p.nameWithOwner;
      if (p.npmStatus === "not-source") {
        label += `  →  npm source: ${p.sourceRepo}`;
      } else if (p.npmStatus === "not-owned") {
        const who = maintainersByRepo.get(p.nameWithOwner)?.join(", ") || "?";
        label += `  →  ${p.packageName} maintained by: ${who}`;
      }
      if (!byReason.has(p.npmStatus)) byReason.set(p.npmStatus, []);
      byReason.get(p.npmStatus).push(label);
    }
    console.error(c("2", "\nExcluded from report:"));
    for (const [reason, names] of byReason) {
      console.error(
        c("2", `  ${reasonLabels[reason] || reason} (${names.length}):`),
      );
      for (const n of names.sort()) console.error(c("2", `    ${n}`));
    }
  }

  const failed = projects.filter(
    (p) => p.npmStatus === "error" || p.npmStatus === "downloads-error",
  );
  if (failed.length) {
    console.error(c("33", "npm lookups that errored (re-run to retry these):"));
    for (const p of failed) {
      console.error(c("2", `  ${p.packageName}: ${p.npmError}`));
    }
  }
  if (skipWrite) {
    console.error(
      c("33", `\nDry run — nothing written (${reported.length} projects, ${sparkEntries.length} release timelines).`),
    );
  } else {
    console.error(c("2", `Wrote ${reported.length} projects to ${jsonPath}`));
    console.error(
      c("2", `Wrote ${sparkEntries.length} release timelines to ${sparkPath}`),
    );
    console.error(c("2", `Wrote aggregate release timeline to ${aggregatePath}`));
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31mError:\x1b[0m ${err.message}`);
  process.exit(1);
});
