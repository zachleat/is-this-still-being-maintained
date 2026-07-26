#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";

import { discoverRepos } from "./lib/github.js";
import { registryMetrics, fetchDownloads } from "./lib/npm.js";
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
        return col.h === "Score" ? c(scoreColor(r.score), cell) : cell;
      })
      .join("  ");
    console.log(line);
  }

  if (limit && rows.length > limit) {
    console.log(c("2", `\n… and ${rows.length - limit} more (see JSON report)`));
  }
}

// Pick the one "source" repo for each npm package name, returning a Set of the
// winners' nameWithOwner. The dedup exists only to collapse duplicates — many
// repos generated from a template (e.g. eleventy-base-blog) share a package.json
// name. Rules:
//   - a package claimed by a SINGLE repo is always kept. npm's `repository` field
//     often lags a GitHub rename (e.g. 11ty/eleventy-img -> 11ty/image), so a
//     mismatch there must not drop the only repo that publishes the package;
//   - when SEVERAL repos claim the same name, prefer the one npm names in its
//     `repository` field; if none match, keep the most-starred as canonical.
function selectSourceRepos(withMeta) {
  const groups = new Map(); // packageName -> [{ repo, meta }]
  for (const entry of withMeta) {
    if (!entry.meta) continue; // unpublished / errored — nothing to attribute
    const key = entry.repo.packageName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const sources = new Set();
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
    sources.add(winner.repo.nameWithOwner);
  }
  return sources;
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

  const configPath = path.resolve(args.config || path.join(__dirname, "config.json"));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const {
    githubUsers = [],
    githubOrgs = [],
    monitor = [],
    exclude = [],
    options = {},
    scoring,
  } = config;

  const monitorSet = new Set(monitor);
  const excludeSet = new Set(exclude);

  const cacheDuration = options.cacheDuration || "1h";

  console.error(
    c("2", `Discovering repos for ${[...githubUsers, ...githubOrgs].join(", ")}…`),
  );
  const repos = await discoverRepos(githubUsers, githubOrgs, {
    duration: cacheDuration,
  });

  // Filter down to the things worth scoring.
  const candidates = repos.filter((r) => {
    if (r.isFork || r.isArchived || r.isPrivate || r.isDisabled) return false;
    if (r.isPrivatePackage) return false; // package.json marked "private": true
    if (excludeSet.has(r.nameWithOwner)) return false;
    if (monitorSet.size > 0 && !monitorSet.has(r.nameWithOwner)) return false;
    if (!r.packageName && !options.includeReposWithoutPackageJson) return false;
    return true;
  });

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

  // Resolve which repo is the canonical source for each package name (dedup).
  const sources = selectSourceRepos(withMeta);

  // Phase 2: download counts — one bulk pass for every published package, so we
  // don't hammer (and get throttled by) the strict downloads API.
  const publishedNames = withMeta
    .filter((x) => x.meta && sources.has(x.repo.nameWithOwner))
    .map((x) => x.repo.packageName);
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

  const projects = withMeta.map(({ repo, meta, error }) => {
    const source = meta ? sources.has(repo.nameWithOwner) : false;
    const downloadError =
      meta && source ? downloadErrorNames.get(repo.packageName) : null;
    const npmStatus = error
      ? "error"
      : meta
        ? source
          ? downloadError
            ? "downloads-error"
            : "published"
          : "not-source"
        : repo.packageName
          ? "unpublished"
          : "no-package";

    const project = {
      nameWithOwner: repo.nameWithOwner,
      owner: repo.nameWithOwner.split("/")[0],
      url: repo.url,
      packageName: repo.packageName || null,
      description: meta?.description || null,
      sourceRepo: meta?.repository || null,
      stars: repo.stars,
      openIssues: repo.openIssues,
      closedIssues: repo.closedIssues,
      openPRs: repo.openPRs,
      mergedPRs: repo.mergedPRs,
      closedPRs: repo.closedPRs,
      pushedAt: repo.pushedAt,
      lastPublish: meta?.lastPublish || null,
      lastPublishVersion: meta?.lastPublishVersion || null,
      lastStablePublish: meta?.lastStablePublish || null,
      lastStablePublishVersion: meta?.lastStablePublishVersion || null,
      firstPublish: meta?.firstPublish || null,
      latestVersion: meta?.latestVersion || null,
      prerelease: meta?.prerelease || false,
      downloads: meta && source ? downloads.get(repo.packageName) ?? 0 : 0,
      downloadsKnown: Boolean(meta) && source && !downloadError,
      downloadsPeriod: period,
      published: Boolean(meta) && source,
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
    ? projects.filter((p) => p.published)
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
  const outputDir = options.outputDir || "docs";
  const jsonPath = path.resolve(
    args.json || path.join(process.cwd(), outputDir, "report.json"),
  );
  const report = {
    config: { githubUsers, githubOrgs, scoring, publishedOnly },
    count: sorted.length,
    projects: sorted,
  };
  await mkdir(path.dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");
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

  // List the shortnames of every discovered repo left out of the report, grouped
  // by why, so exclusions are auditable (spot a repo that shouldn't be missing).
  const excluded = projects.filter((p) => !reported.includes(p));
  if (excluded.length) {
    const reasonLabels = {
      unpublished: "not on npm",
      "not-source": "package.json copy (not the npm source)",
      "no-package": "no package.json",
      error: "npm lookup error",
    };
    const byReason = new Map();
    for (const p of excluded) {
      const label =
        p.npmStatus === "not-source"
          ? `${p.nameWithOwner}  →  npm source: ${p.sourceRepo}`
          : p.nameWithOwner;
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
  console.error(c("2", `Wrote ${reported.length} projects to ${jsonPath}`));
}

main().catch((err) => {
  console.error(`\n\x1b[31mError:\x1b[0m ${err.message}`);
  process.exit(1);
});
