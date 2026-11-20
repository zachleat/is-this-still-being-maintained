import { test } from "node:test";
import assert from "node:assert/strict";

import { setDryRun } from "../lib/fetch.js";
import { registryMetrics } from "../lib/npm.js";

const versions = (list) =>
  Object.fromEntries(list.map(([v, description]) => [v, { version: v, description }]));

async function metricsFor(t, doc) {
  setDryRun(true);
  t.mock.method(globalThis, "fetch", async () => Response.json(doc));
  // Unique name so nothing collides with the disk cache.
  return registryMetrics(`zz-test-${process.pid}-${Date.now()}-${Math.random()}`, "1h");
}

test("a stable patch on the old line doesn't hide a newer prerelease", async (t) => {
  const m = await metricsFor(t, {
    "dist-tags": { latest: "3.1.8" },
    versions: versions([
      ["3.1.7", "old"],
      ["4.0.0-alpha.10", "new"],
      ["3.1.8", "old"],
    ]),
    time: {
      "3.1.7": "2026-01-01T00:00:00Z",
      "4.0.0-alpha.10": "2026-02-01T00:00:00Z",
      "3.1.8": "2026-03-01T00:00:00Z",
    },
  });
  assert.equal(m.lastPublishVersion, "3.1.8");
  assert.equal(m.prereleaseVersion, "4.0.0-alpha.10");
  assert.equal(m.prerelease, true);
  assert.equal(m.description, "new");
});

test("only prereleases ahead of a prerelease `latest` count", async (t) => {
  const m = await metricsFor(t, {
    "dist-tags": { latest: "4.0.0-alpha.1" },
    versions: versions([
      ["3.3.0", "x"],
      ["4.0.0-alpha.1", "x"],
      ["4.0.0-alpha.4", "x"],
      ["0.0.0-canary-abc", "x"],
    ]),
    time: {
      "4.0.0-alpha.1": "2026-01-01T00:00:00Z",
      "4.0.0-alpha.4": "2026-02-01T00:00:00Z",
      "3.3.0": "2026-03-01T00:00:00Z",
      "0.0.0-canary-abc": "2026-04-01T00:00:00Z",
    },
  });
  assert.equal(m.prereleaseVersion, "4.0.0-alpha.4");
});

test("prereleases behind `latest` are ignored", async (t) => {
  const m = await metricsFor(t, {
    "dist-tags": { latest: "2.0.0" },
    versions: versions([
      ["2.0.0-beta.1", "x"],
      ["2.0.0", "x"],
      ["1.5.0-beta.1", "x"],
    ]),
    time: {
      "2.0.0-beta.1": "2026-01-01T00:00:00Z",
      "2.0.0": "2026-02-01T00:00:00Z",
      "1.5.0-beta.1": "2026-03-01T00:00:00Z",
    },
  });
  assert.equal(m.lastPublishVersion, "1.5.0-beta.1");
  assert.equal(m.prereleaseVersion, null);
  assert.equal(m.prerelease, false);
});
