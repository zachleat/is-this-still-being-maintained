import { cachedJSON, is404 } from "./fetch.js";

const DEPS_DEV = "https://api.deps.dev/v3alpha/systems/npm/packages";
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_MAX_QUERIES = 1000; // OSV's documented cap per batch request

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n),
  );

/**
 * The resolved transitive dependency tree of a *published* package version, via
 * deps.dev. This is what consumers actually install — so devDependencies are
 * excluded by construction, and no lockfile is needed.
 * Returns an array of { name, version }, or null when deps.dev has no data.
 */
export async function resolvedDependencies(name, version, duration) {
  const url = `${DEPS_DEV}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}:dependencies`;
  let data;
  try {
    data = await cachedJSON(url, { duration });
  } catch (err) {
    if (is404(err)) return null; // version not indexed
    throw err;
  }
  // nodes[0] is the package itself; the rest are its resolved dependencies.
  return (data?.nodes ?? [])
    .slice(1)
    .map((n) => n.versionKey)
    .filter((k) => k?.name && k?.version)
    .map((k) => ({ name: k.name, version: k.version }));
}

/**
 * Look up known vulnerabilities for many (name, version) pairs in as few OSV
 * batch requests as possible. Returns a Map of "name@version" -> advisory count.
 */
export async function osvVulnerabilityCounts(pairs, duration) {
  const counts = new Map();
  for (const group of chunk(pairs, OSV_MAX_QUERIES)) {
    const queries = group.map((p) => ({
      package: { name: p.name, ecosystem: "npm" },
      version: p.version,
    }));
    const data = await cachedJSON(OSV_BATCH, {
      duration,
      fetchOptions: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries }),
      },
    });
    (data?.results ?? []).forEach((res, i) => {
      const p = group[i];
      counts.set(`${p.name}@${p.version}`, (res?.vulns ?? []).length);
    });
  }
  return counts;
}

/**
 * Audit published packages for known-vulnerable dependencies — an `npm audit`
 * equivalent that needs no authentication.
 *
 * For each { name, version } it resolves the published dependency tree
 * (deps.dev) and counts advisories against those exact versions (OSV.dev).
 * Dependency versions are deduped across all packages so OSV is queried once for
 * the whole set rather than per package.
 *
 * Returns a Map of package name -> vulnerability count, or `null` when the tree
 * couldn't be resolved (unknown rather than "zero").
 */
export async function auditPackages(packages, { duration, concurrency = 8 } = {}) {
  // 1. Resolve each package's dependency tree (concurrent, cached).
  const trees = new Map(); // package name -> [{name,version}] | null
  let next = 0;
  async function worker() {
    while (next < packages.length) {
      const pkg = packages[next++];
      try {
        trees.set(
          pkg.name,
          await resolvedDependencies(pkg.name, pkg.version, duration),
        );
      } catch {
        trees.set(pkg.name, null); // lookup failed — unknown, not zero
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, packages.length) }, worker),
  );

  // 2. One OSV pass over every distinct dependency version in all trees.
  const unique = new Map();
  for (const deps of trees.values()) {
    for (const d of deps ?? []) unique.set(`${d.name}@${d.version}`, d);
  }
  let vulnByDep = new Map();
  try {
    vulnByDep = await osvVulnerabilityCounts([...unique.values()], duration);
  } catch {
    return new Map(packages.map((p) => [p.name, null])); // OSV down — all unknown
  }

  // 3. Total advisories across each package's tree.
  const results = new Map();
  for (const pkg of packages) {
    const deps = trees.get(pkg.name);
    if (deps == null) {
      results.set(pkg.name, null);
      continue;
    }
    let total = 0;
    for (const d of deps) total += vulnByDep.get(`${d.name}@${d.version}`) ?? 0;
    results.set(pkg.name, total);
  }
  return results;
}
