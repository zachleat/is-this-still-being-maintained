import { test } from "node:test";
import assert from "node:assert/strict";

import { setDryRun } from "../lib/fetch.js";
import { fetchDownloadsAllTime } from "../lib/npm.js";

// Fake package names so nothing collides with real entries in the disk cache.
const id = `zz-test-${process.pid}-${Date.now()}`;
const UNSCOPED = `${id}-a`;
const SCOPED = `@${id}/b`;
const FAILING = `@${id}/c`;

test("sums one request per calendar year from firstPublish to now", async (t) => {
  setDryRun(true);
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const { pathname } = new URL(url);
    requested.push(decodeURIComponent(pathname));
    const [, , , range, ...rest] = pathname.split("/");
    const name = decodeURIComponent(rest.join("/"));
    const year = Number(range.slice(0, 4));
    if (name === FAILING && year === 2025) {
      return new Response("nope", { status: 400 });
    }
    return Response.json({ downloads: year - 2020, package: name });
  });

  const { totals, errors } = await fetchDownloadsAllTime(
    [
      { name: UNSCOPED, since: "2023-05-01T00:00:00.000Z" },
      { name: SCOPED, since: "2024-12-31T00:00:00.000Z" },
      { name: FAILING, since: "2024-01-01T00:00:00.000Z" },
    ],
    { duration: "1h", now: new Date("2026-03-01T00:00:00Z") },
  );

  assert.equal(totals.get(UNSCOPED), 3 + 4 + 5 + 6);
  assert.equal(totals.get(SCOPED), 4 + 5 + 6);
  assert.equal(totals.has(FAILING), false);
  assert.deepEqual(errors.map((e) => e.name), [FAILING]);
  assert.ok(requested.includes(`/downloads/point/2023-01-01:2023-12-31/${UNSCOPED}`));
  assert.ok(requested.includes(`/downloads/point/2024-01-01:2024-12-31/${SCOPED}`));
  assert.ok(!requested.some((p) => p.includes("2022-")));
  // A failed package isn't requested for later years.
  assert.ok(!requested.includes(`/downloads/point/2026-01-01:2026-12-31/${FAILING}`));
});

test("reads completed years from byYear and records newly fetched ones", async (t) => {
  setDryRun(true);
  const name = `${id}-d`;
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const { pathname } = new URL(url);
    requested.push(pathname);
    return Response.json({ downloads: 10, package: name });
  });

  const input = { [name]: { 2024: 7 } };
  const { totals, byYear } = await fetchDownloadsAllTime(
    [{ name, since: "2024-01-01T00:00:00.000Z" }],
    { duration: "1h", now: new Date("2026-03-01T00:00:00Z"), byYear: input },
  );

  assert.equal(totals.get(name), 7 + 10 + 10);
  assert.ok(!requested.some((p) => p.includes("2024-")));
  // The current year is never stored, and the input isn't mutated.
  assert.deepEqual(byYear, { [name]: { 2024: 7, 2025: 10 } });
  assert.deepEqual(input, { [name]: { 2024: 7 } });
});
