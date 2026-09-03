#!/usr/bin/env node
/**
 * `npm run reset` — clear this checkout of one person's data so it can be
 * pointed at someone else's: delete the generated reports and replace
 * config.json with the blank sample.
 *
 * Destructive but recoverable: config.json and the reports are tracked in git,
 * so `git checkout config.json docs/` restores them.
 */
import { copyFile, readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configPath = path.join(root, "config.json");
const samplePath = path.join(root, "config.sample.json");

const REPORTS = [
  "report.json",
  "report-sparklines.json",
  "report-sparkline-aggregate.json",
];

// Read the OLD config first: it knows where the reports were written. Doing
// this after the overwrite would look in the sample's outputDir instead.
let outputDir = "docs";
try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  outputDir = config?.options?.outputDir || outputDir;
} catch {
  // No config (or unreadable) — fall back to the default location.
}

const removed = [];
for (const name of REPORTS) {
  const file = path.resolve(root, outputDir, name);
  try {
    await unlink(file);
    removed.push(path.relative(root, file));
  } catch (err) {
    if (err.code !== "ENOENT") throw err; // already gone is fine
  }
}

await copyFile(samplePath, configPath);

console.log(
  removed.length
    ? `Removed ${removed.length} report file(s):\n  ${removed.join("\n  ")}`
    : "No report files to remove.",
);
console.log("Reset config.json from config.sample.json");
console.log(
  "\nNext: add your githubUsers / githubOrgs / npmMaintainers to config.json.",
);
console.log(
  "The .cache/ directory is untouched; delete it to force fresh API calls.",
);
console.log("To undo: git checkout config.json " + outputDir + "/");
