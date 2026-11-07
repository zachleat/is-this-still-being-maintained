#!/usr/bin/env node
// One-shot: rebuild each project's `scoreHistoryWeekly` in docs/report.json from its git history.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = "docs/report.json";
const jsonPath = path.join(root, file);
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const weekStart = (iso) => {
  const d = new Date(iso.slice(0, 10));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

// week -> Map(packageName -> score), later reports in a week overwrite earlier ones.
const weeks = new Map();
const record = (report, fallbackDate) => {
  const date = report.generatedAt || fallbackDate;
  const scores = new Map();
  for (const p of report.projects || []) {
    if (p.packageName && typeof p.score === "number") scores.set(p.packageName, p.score);
  }
  weeks.set(weekStart(date), scores);
};

// Early reports have no generatedAt, so fall back to the commit date.
const commits = git("log", "--reverse", "--format=%H %cI", "--", file).trim().split("\n").filter(Boolean);
for (const line of commits) {
  const [sha, committed] = line.split(" ");
  try {
    record(JSON.parse(git("show", `${sha}:${file}`)), new Date(committed).toISOString());
  } catch {
    // Skip commits where the file was missing or unparsable.
  }
}

const current = JSON.parse(await readFile(jsonPath, "utf8"));
record(current);
const order = [...weeks.keys()].sort();

const withField = (obj, afterKey, key, value) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue;
    out[k] = v;
    if (k === afterKey) out[key] = value;
  }
  if (!(key in out)) out[key] = value;
  return out;
};

current.projects = current.projects.map((p) => {
  const series = order.filter((w) => weeks.get(w).has(p.packageName)).map((w) => weeks.get(w).get(p.packageName));
  return withField(p, "scoreHistory", "scoreHistoryWeekly", series.slice(-26));
});
const out = withField(current, "healthRatingHistory", "scoreHistoryWeeklyEnd", weekStart(current.generatedAt));

await writeFile(jsonPath, JSON.stringify(out, null, 2) + "\n");
console.log(`${commits.length} commits, ${order.length} weeks (${order[0]} to ${order.at(-1)})`);
