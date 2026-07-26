// ---------------------------------------------------------------------------
// The "Needs maintenance" score. This is the knob-turning heart of the tool —
// it is intentionally small and transparent so you can tune it in config.json.
//
// Guiding idea:  a package needs maintenance when there is unaddressed work
// (open issues / PRs) AND nobody is addressing it (stale). Both conditions
// matter, so they MULTIPLY rather than add:
//
//   score = 100 * neglect * importance
//   neglect = staleness * demand
//
//   staleness   0..1       how long since a git push or npm publish
//   demand      floor..1   how much open work is piling up (issues + PRs)
//   importance  floor..1   popularity, as a multiplier
//
// Consequences that fall out of the multiplication:
//   • A stable, "done" package (old, popular, but zero issues/PRs) scores LOW —
//     age alone isn't neglect if nobody needs anything. `demand` bottoms out at
//     `backlogFloor`.
//   • A freshly-released project scores ~0 no matter how big its backlog —
//     recent activity means the maintainer is engaged. `staleness` bottoms at 0.
//   • The top of the list is what you actually want: open work rotting on a
//     project nobody has touched in a long time.
//
// Higher score = needs attention more urgently.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round = (n) => Math.round(n * 1000) / 1000;

function daysSince(iso, now) {
  if (!iso) return null;
  return (now - new Date(iso).getTime()) / DAY;
}

// log-scaled 0..1: `saturation` is the count at which the sub-score reaches ~1.
function logScale(count, saturation) {
  if (count <= 0) return 0;
  return clamp01(Math.log10(count + 1) / Math.log10(saturation + 1));
}

export function scoreProject(project, scoring, now = Date.now()) {
  const {
    backlogWeights,
    backlogFloor,
    fullyStaleDays,
    issuesSaturation,
    prsSaturation,
    downloadsSaturation,
    starsSaturation,
    importanceWeights,
    importanceFloor,
  } = scoring;

  // Most-recent signal of life: a git push or a STABLE npm publish, whichever is
  // newer. Prerelease publishes (alphas/betas) are intentionally ignored here —
  // staleness keys off the `latest` dist-tag only — though frequent prerelease
  // activity still shows up via the git `pushedAt` signal.
  const activityDays = Math.min(
    daysSince(project.pushedAt, now) ?? Infinity,
    daysSince(project.lastStablePublish, now) ?? Infinity,
  );
  const staleness =
    activityDays === Infinity ? 1 : clamp01(activityDays / fullyStaleDays);

  // Demand: log-scaled, PR-weighted backlog. Zero open work -> demand == floor.
  const issuesSub = logScale(project.openIssues, issuesSaturation);
  const prsSub = logScale(project.openPRs, prsSaturation);
  const bwSum = backlogWeights.openIssues + backlogWeights.openPRs || 1;
  const backlogSeverity =
    (issuesSub * backlogWeights.openIssues + prsSub * backlogWeights.openPRs) /
    bwSum;
  const demand = backlogFloor + (1 - backlogFloor) * backlogSeverity;

  const neglect = staleness * demand;

  // Importance blends two popularity signals, each log-scaled (both span many
  // orders of magnitude): npm downloads (weighted higher) and GitHub stars.
  const downloadsSub = logScale(project.downloads, downloadsSaturation);
  const starsSub = logScale(project.stars, starsSaturation);
  const iwSum = importanceWeights.downloads + importanceWeights.stars || 1;
  const popularity =
    (downloadsSub * importanceWeights.downloads +
      starsSub * importanceWeights.stars) /
    iwSum;
  const importance = importanceFloor + (1 - importanceFloor) * popularity;

  const score = 100 * neglect * importance;

  return {
    score: Math.round(score * 10) / 10,
    breakdown: {
      activityDays: activityDays === Infinity ? null : Math.round(activityDays),
      staleness: round(staleness),
      issuesSub: round(issuesSub),
      prsSub: round(prsSub),
      backlogSeverity: round(backlogSeverity),
      demand: round(demand),
      downloadsSub: round(downloadsSub),
      starsSub: round(starsSub),
      popularity: round(popularity),
      neglect: round(neglect),
      importance: round(importance),
    },
  };
}
