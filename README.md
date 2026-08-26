# is-this-still-being-maintained

Fetches every open source package you own across a set of GitHub users/orgs and
gives each one a **"Needs maintenance" score** (0–100, higher = more neglected)
from npm downloads, last publish date, and open issues/PRs.

Node 20+. Uses your `gh` login (or a `GITHUB_TOKEN`) for the GitHub API and the
public npm registry for download stats. Every network request is cached to disk
for 30 minutes via [`@11ty/eleventy-fetch`][fetch] (the only dependency), so repeat
runs are near-instant and don't re-hit the APIs.

[fetch]: https://www.11ty.dev/docs/plugins/fetch/

## Usage

```bash
npm install                # installs @11ty/eleventy-fetch
gh auth login              # once, if you haven't
node index.js              # prints a table, writes docs/report.json
```

Options:

```
--config <path>   Config file (default: ./config.json)
--json <path>     Where to write the JSON report (default: ./docs/report.json)
--limit <n>       Only print the top N rows (JSON still has everything)
--dry-run         Print the table only — writes nothing to disk (no JSON files,
                  no cache). The cache is still read, so it stays fast.
--no-color        Disable ANSI colors
```

## Configuration (`config.json`)

```jsonc
{
  "githubUsers": ["zachleat"],   // scan every public non-fork repo for these users…
  "githubOrgs":  ["11ty"],       // …and these orgs
  "npmMaintainers": ["zachleat"], // npm usernames that count as "yours" (see below).
                                  //   Empty/omitted = skip the ownership check.

  "monitor": [],                  // opt-in allowlist of "owner/repo". If non-empty,
                                  //   ONLY these repos are scored. Empty = score all.
  "exclude": [],                  // "owner/repo" entries to always skip (wins over all)
  "alwaysInclude": [],            // "owner/repo" entries to force-keep, bypassing the
                                  //   automatic filters (archived, private package.json,
                                  //   template dedup, unpublished, monitor allowlist).
                                  //   Also pulls in the repo's workspace members,
                                  //   including private ones.
  "alwaysIncludePackages": [],    // same, but keyed by npm package name — targets a
                                  //   single package (e.g. one workspace member)
                                  //   without its siblings.

  "options": {
    "publishedOnly": true,                    // only report packages actually on npm
    "includeReposWithoutPackageJson": false,  // consider repos that aren't npm packages
    "downloadsPeriod": "last-month",          // last-day | last-week | last-month
    "cacheDuration": "1h",                    // disk cache TTL: "1h", "1d", "60s", etc.
    "outputDir": "docs",                      // directory for report.json
    "concurrency": 8
  },

  "scoring": { /* see below */ }
}
```

A repo is skipped automatically if it's a fork, private, disabled, or has a
`package.json` marked `"private": true`, or (by default) if it has no
`package.json`. To force one of these back in, list its `"owner/repo"` in
`alwaysInclude` — it bypasses every automatic filter (and the template-dedup and
`publishedOnly` drops), and it also pulls in that repo's **workspace members**,
even ones marked `private: true`. To keep a *single* package instead of a whole
repo's worth (e.g. one private workspace member without its siblings), list the
npm package name in `alwaysIncludePackages`. `exclude` still wins over both, and
a misspelled entry that matches no discovered repo/package prints a warning.

**Archived repos are kept**, flagged with `isArchived: true`. Archiving retires
the *repo*, not the published package — the code stays on npm and people keep
installing it — so archived projects still contribute their publishing and
download stats to the report and the cumulative totals. They always score 0
(see below).

**Template copies are de-duplicated.** Many repos are generated from a starter
(e.g. `eleventy-base-blog`) and keep the template's `package.json` name, so
several repos claim the same npm package. Each published package is attributed
only to the repo npm names in its `repository` field; repos that merely inherited
the name are marked `not-source` and dropped, so the same package never appears
more than once. If npm has no `repository` field, the package is kept as-is (it
can't be disproven). With `publishedOnly` (the default),
repos that have a `package.json` but were never published to npm — demos,
starters, one-offs — are also left out of the report; the run summary still
tells you how many were excluded. Set `publishedOnly: false` to include them.

**npm workspaces are expanded.** If a repo's root `package.json` declares
`workspaces`, each published workspace member becomes its own project (matched
paths: exact dirs and a single trailing `/*`). A member carries its own npm
metrics (downloads, publish dates, maintainers) but **inherits the parent repo's
GitHub metrics** — stars, issues, and PRs are repo-level and can't be split per
package, so sibling packages in one monorepo share those signals. The workspace
root itself (usually `private: true` with no name) is filtered as normal, and
each member records its `workspacePath` in the JSON. This is what surfaces
packages like `@11ty/eleventy-utils` that live only inside a monorepo.

**GitHub template repositories are kept even without npm.** A repo flagged as a
template (`isTemplate`) is worth tracking as a maintained project even if it has
no `package.json` or was never published, so it's included and scored on its
GitHub activity alone. If its name happens to collide with someone else's npm
package, that foreign npm data is *not* attached — the template shows no
downloads/publish dates and scores purely on repo signals. (Templates still
respect the fork/private filters.)

**Ownership is verified by npm maintainers.** A repo can share a name with an npm
package published by someone else — e.g. your `eleventy-base-blog` repo vs the
`eleventy-base-blog` on npm, which is maintained by a different account. The
`repository` field can't be trusted here (it's set by whoever wrote that
package.json, not verified by npm). So if `npmMaintainers` is set, a package is
attributed to you only when one of those usernames is a **current npm
maintainer**; otherwise it's marked `not-owned` and dropped (the excluded list
names who actually maintains it). Leave `npmMaintainers` empty to skip the check.

## How the score works

`lib/score.js` is small and self-contained — it's meant to be edited. The
guiding idea: a package needs maintenance when there is **unaddressed work**
(open issues/PRs) *and* **nobody is addressing it** (stale). Both matter, so they
multiply:

```
score     = 100 × attention × importance
attention = max(neglect, security)
neglect   = staleness × demand
```

- **staleness** (0–1): days since the most recent git push *or* npm publish,
  ramping to 1.0 at `fullyStaleDays` (default 730 = 2 years).
- **demand** (`backlogFloor`–1): how much open work is piling up — see below.
- **security** (0–`securityWeight`): open runtime vulnerabilities, a separate
  term that ignores staleness — see [Security](#security-a-separate-staleness-independent-term).
- **archived repos always score 0**: `attention` is forced to 0, because
  archiving is an explicit "no longer maintained" declaration — nothing is being
  asked of the project, however big its backlog. The `neglect` and `security`
  sub-scores are still reported in `breakdown` so you can see what it would
  otherwise have scored, and its download/publish stats still count.
- **importance** (`importanceFloor`–1): popularity as a multiplier, so an
  unpopular package still counts (down to `importanceFloor`, default 0.3) but a
  widely-used one weighs more. It blends two log-scaled signals via
  `importanceWeights` — npm **downloads** (default 0.7, saturating at
  `downloadsSaturation` = 1,000,000/month) and GitHub **stars** (default 0.3,
  saturating at `starsSaturation` = 5,000). Lower `importanceFloor` to make
  popularity matter more overall; shift `importanceWeights` to trade downloads
  against stars.

Because the terms multiply, two things fall out for free:

- A **stable, "done" package** — old and popular but with **zero issues/PRs** —
  scores low. `demand` bottoms out at `backlogFloor`, so age alone isn't treated
  as neglect. (e.g. `@11ty/lodash-custom`: 467k downloads, 3 years old, no open
  work → mid-pack, not #1.)
- A **freshly-released project** scores ~0 no matter how big its backlog, because
  `staleness ≈ 0`. Recent activity means the maintainer is engaged. (e.g.
  `@11ty/eleventy`: 156 issues but released weeks ago → ~0.)

### demand — the open issues & PRs signal

Raw counts are deceptive: a busy flagship accrues issues *because* it's popular.
Backlog counts unaddressed work — open **issues** and open **PRs** — and is
shaped these ways:

- **Log-scaled** counts (`issuesSaturation` 300, `prsSaturation` 60), so a couple
  of items move the needle but a huge pile doesn't just peg the ceiling.
- **PR-weighted** (`backlogWeights`, default issues 0.3 / PRs 0.7): an ignored PR
  is a stronger "not maintained" signal than an open issue.

(Security vulnerabilities are handled by a separate term — see below — because
they should surface even on an actively-maintained repo.)
- **Floored** (`backlogFloor`, default `0`): open work is *required* to score.
  With zero open issues and zero open PRs, `demand` collapses to 0, so
  `neglect = staleness × 0 = 0` — and with no vulnerabilities the security term is
  0 too. A package with **no issues, no PRs, and no vulnerabilities scores exactly
  0 no matter how old it is**: age alone isn't neglect if nobody is asking for
  anything and nothing is broken. Raise `backlogFloor` toward 1 to let
  staleness/popularity contribute on their own again (e.g. `0.05` gives stale,
  widely-used, zero-backlog packages a faint nonzero score).

Tune any of these in `config.json` under `"scoring"`. Every sub-score is written
into each project's `breakdown` in the JSON report so you can see exactly why
something ranked where it did.

### Security (a separate, staleness-independent term)

`score = 100 × attention × importance`, where `attention = max(neglect,
security)`. So security is its **own** term, not part of `demand` — it **bypasses
the staleness gate**, because an unpatched vulnerability is urgent even on an
actively-pushed repo. `security = securitySub × securityWeight` (default
`securityWeight` 0.5), where `securitySub` is the log-scaled runtime alert count
(`vulnerabilitiesSaturation` 10). A vulnerable-but-active package now surfaces on
its `security` term even when `neglect` is ~0.

`openVulnerabilities` counts known-vulnerable dependencies in the package's
**published** dependency tree — an `npm audit` equivalent assembled from two
free, unauthenticated APIs:

1. **[deps.dev](https://deps.dev)** resolves the published version's full
   transitive dependency tree (no lockfile needed).
2. **[OSV.dev](https://osv.dev)** is batch-queried for advisories against those
   exact dependency versions.

Why this rather than GitHub's Dependabot alerts:

- **No auth at all** — no PAT, no `security_events` scope, no per-repo admin
  access, and CI behaves exactly like a local run.
- **It measures what consumers install.** npm doesn't ship lockfiles for
  dependencies, so a consumer of your library resolves fresh — the published tree
  is what actually reaches them. (Dependabot instead scans *your repo's* lockfile,
  which mostly reflects your own dev environment.)
- **Runtime only by construction** — a published tree has no devDependencies, so
  there's nothing to filter out.
- **npm packages only** — templates, unpublished repos, and docs sites report
  `null` and get no security signal.

Dependency versions are deduped across every package, so OSV is queried once for
the whole set rather than per package. A package whose tree can't be resolved
reports `null` (unknown) rather than a misleading `0`. The trade-off: this won't
flag a stale **lockfile** in your own repo — that's what Dependabot on GitHub is
for, and it already emails you.

### A note on "staleness"

Staleness uses the **most recent** of a git push or a **stable** npm publish (the
`latest` dist-tag). Prerelease publishes (alphas/betas) are deliberately ignored
in the score — a package that only ships prereleases isn't counted as "released"
— but frequent prerelease work still keeps a repo fresh via its git `pushedAt`.
The report still records the prerelease dates (`lastPublish` /
`lastPublishVersion`); they're just not fed into staleness. To use them anyway,
point `activityDays` in `lib/score.js` back at `project.lastPublish`.

## Caching

All GitHub and npm responses are cached to `.cache/` for `cacheDuration`
(default 1 hour) via `@11ty/eleventy-fetch`. The first run does the real work
(~1 min for ~100 repos); subsequent runs within the hour are near-instant and
make no network requests. The GraphQL cache key includes the request body, so
each owner/page is cached separately. To force a fresh pull, delete `.cache/` or
set a shorter `cacheDuration`. If a request fails but an expired cache entry
exists, eleventy-fetch falls back to the stale value rather than erroring.

## Output

- **stdout**: a cumulative **Health Rating** headline, then a table sorted
  worst-first by score, colored (red ≥60, yellow ≥30).
- **Health Rating** (`healthRating`, also a top-level field in `report.json`): a
  single 0–100 measure of how maintained *all* your packages are — the plain mean
  of per-package health (`100 − score`), counting every package equally. Higher
  is better.

  It is deliberately **not** download-weighted. npm downloads are power-law
  distributed, so weighting by them lets a handful of mega-packages own the score
  and a long tail of abandoned packages barely register (for the `react` org that
  was the difference between 96.9 and 86.7, with the top 5 packages holding 60%
  of the weight). Popularity is still represented, because each package's own
  `score` is already scaled by importance.
- **`docs/report.json`** (directory set by `outputDir`, created if
  missing; override the full path with `--json`): `{ config, count, projects[] }`,
  each project carrying raw metrics + `score` + `breakdown`. Projects are sorted
  **alphabetically by package name** (not by score) so the file is stable to
  commit to source control — each package keeps its line across runs and diffs
  show real metric changes instead of churn from shifting ranks. This is the feed
  for "maybe other things later" — a dashboard, a diff over time, a CI gate, etc.

Each project carries a `scoreHistory` — an array of its last 10 neglect `score`s,
so you can see a package trending better or worse over time. It's persisted by
reading the previous `report.json`: a run on a **new calendar day** appends the
current score, while a **same-day rerun replaces** the newest entry (using the
report's `generatedAt`, so reruns don't pile up). Oldest drops off past 10. The
top-level **`healthRatingHistory`** tracks the overall Health Rating the same way.

Each project's **`description`** comes from the published `latest` version's
npm `package.json`, falling back to the **GitHub repo description** when there's
no npm data — so templates and unpublished repos still get one. The two often
differ (a repo's GitHub "About" blurb is usually punchier than its terse
`package.json` description); npm wins whenever the package is published.

Each project carries **`isPinned`** — `true` when the repo is pinned to any of
the configured profiles (`githubUsers` / `githubOrgs`). Pins can cross owners (a
user can pin an org's repo), so pins from every configured login are pooled into
one set; workspace members inherit their parent repo's value. Reported only —
it doesn't affect scoring or filtering.

Each published package carries **`npmDeprecated`** — `true` when its `latest`
version is marked deprecated on npm (`null` for anything not published). This is
**reported only**: it does not feed the score, filtering, or any other logic.

Each project also carries an `isWebComponent` flag — a heuristic that's `true`
when the package's `main` entry file (from `package.json`, defaulting to
`index.js`) contains a `customElements` reference. Main files are fetched batched
across repos (a few GraphQL requests, cached), so it's cheap.

- **`docs/report-sparklines.json`** — a companion file with each published
  package's npm release timeline, for drawing a release-cadence sparkline. Per
  package: `publishCount`, `firstPublish`/`lastPublish`, and `monthlyReleases`
  (`{ start: "YYYY-MM", counts: [...] }` — a dense per-month release count series
  you can feed straight to a sparkline). Sorted alphabetically like the main
  report, and committed by the daily workflow too.
- **`docs/report-sparkline-aggregate.json`** — the same `monthlyReleases`
  shape, but a *single* series summing releases across **all** published
  packages per month (total publishing cadence over time).

Each project has an `npmStatus`, so "no data" is never ambiguous:

| `npmStatus`       | Meaning                                                        |
| ----------------- | ------------------------------------------------------------- |
| `published`       | On npm; downloads + publish date are real                     |
| `unpublished`     | Has a `package.json` but was never published (demos, starters)|
| `not-source`      | A copy that inherited another repo's package name (deduped)   |
| `not-owned`       | npm package of that name is maintained by someone else        |
| `no-package`      | Repo has no root `package.json`                               |
| `downloads-error` | Published, but the downloads lookup failed — **re-run to fix**|
| `error`           | Registry lookup failed after retries — **re-run to fix**      |

Only `published` (and `downloads-error`, which is still published) appear in the
report by default; the rest are excluded and listed in the run summary.

### About rate limits

npm's downloads API (`api.npmjs.org`) is strict. The tool minimizes requests
(bulk endpoint for unscoped packages, gentle sequential fetches for scoped ones)
and retries transient failures with backoff. A failed lookup is **never** silently
counted as "zero downloads" or "unpublished" — it's surfaced as `downloads-error`
/ `error`, and a re-run picks up where it left off. If you routinely see a handful
of `downloads-error` rows, lower `options.concurrency` in `config.json`.

## Automation (daily)

[`.github/workflows/maintenance-report.yml`](.github/workflows/maintenance-report.yml)
regenerates the report every day at 12:00 UTC (and on demand via **workflow
dispatch**), then commits `docs/report.json` back to the repo — but
only when it changed. Because the report is sorted and timestamp-free, each
commit is a clean diff, giving you a git history of how your scores drift over
time.

It authenticates with the Actions-provided `GITHUB_TOKEN`, which can read public
data across GitHub. If you need private/org visibility or a higher rate limit,
add a PAT as a repo secret named `MAINTENANCE_GH_TOKEN` — the workflow prefers it
when present. To change the cadence, edit the `cron` line. (If your default
branch has protections that block the `github-actions[bot]` push, allow it or
point the workflow at a branch/PR instead.)

## Ideas for later

- Dependency freshness (outdated deps / known advisories)
- Issue/PR *age* and staleness of the oldest open ones, not just counts
- Response latency: time-to-first-maintainer-reply on recent issues
- Trend: store reports over time and flag score deltas
- CI status / failing default branch
