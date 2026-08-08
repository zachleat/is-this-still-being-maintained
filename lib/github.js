import { execFileSync } from "node:child_process";

import { cachedJSON } from "./fetch.js";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

// Resolve a GitHub token: env vars first (works in CI), then the `gh` CLI.
let cachedToken;
function getToken() {
  if (cachedToken !== undefined) return cachedToken;

  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return (cachedToken = fromEnv);

  try {
    cachedToken = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    cachedToken = "";
  }

  if (!cachedToken) {
    throw new Error(
      "No GitHub token found. Either run `gh auth login`, or set GITHUB_TOKEN / GH_TOKEN.",
    );
  }
  return cachedToken;
}

async function graphql(query, variables, duration) {
  // Cached via eleventy-fetch. The cache key includes the POST body, so each
  // distinct query/variables pair (owner + pagination cursor) caches separately.
  const body = await cachedJSON(GRAPHQL_ENDPOINT, {
    duration,
    fetchOptions: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
        "User-Agent": "is-this-still-being-maintained",
      },
      body: JSON.stringify({ query, variables }),
    },
  });

  if (body.errors?.length) {
    throw new Error(
      `GitHub GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return body.data;
}

const REPOS_QUERY = `
query($login: String!, $cursor: String) {
  repositoryOwner(login: $login) {
    __typename
    repositories(
      first: 100
      after: $cursor
      ownerAffiliations: OWNER
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        nameWithOwner
        url
        homepageUrl
        isArchived
        isFork
        isPrivate
        isDisabled
        isTemplate
        createdAt
        pushedAt
        stargazerCount
        openIssues: issues(states: OPEN) { totalCount }
        closedIssues: issues(states: CLOSED) { totalCount }
        openPRs: pullRequests(states: OPEN) { totalCount }
        mergedPRs: pullRequests(states: MERGED) { totalCount }
        closedPRs: pullRequests(states: CLOSED) { totalCount }
        packageJson: object(expression: "HEAD:package.json") {
          ... on Blob { text }
        }
      }
    }
  }
}`;

// Walk every public, non-fork repo for one user or org.
async function reposForOwner(login, duration) {
  const repos = [];
  let cursor = null;

  do {
    const data = await graphql(REPOS_QUERY, { login, cursor }, duration);
    const owner = data.repositoryOwner;
    if (!owner) {
      throw new Error(`GitHub owner not found: "${login}"`);
    }
    const page = owner.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return repos;
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) =>
    arr.slice(i * n, i * n + n),
  );

// Immediate entries under a directory in a repo (used to resolve `packages/*`).
async function listDirEntries(owner, name, path, duration) {
  const data = await graphql(
    `query($owner:String!,$name:String!,$expr:String!){
      repository(owner:$owner,name:$name){
        object(expression:$expr){ ... on Tree { entries { name type } } }
      }
    }`,
    { owner, name, expr: `HEAD:${path}` },
    duration,
  );
  return data.repository?.object?.entries ?? [];
}

// Build one GraphQL query with an aliased `repository{ object }` block per request.
function crossRepoQuery(group, blobField) {
  const parts = group.map((req, i) => {
    const [owner, name] = req.repo.split("/");
    return `r${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ object(expression:${JSON.stringify(`HEAD:${req.path}`)}){ ... on Blob { ${blobField} } } }`;
  });
  return `query{ ${parts.join("\n")} }`;
}

/**
 * Fetch one file from each of many repos, batched into few GraphQL requests.
 * `requests` is a list of { key, repo: "owner/name", path }; returns a Map of
 * key -> file text (missing/oversized files are simply absent).
 *
 * Blob text is fetched in byte-budgeted batches: GitHub silently returns null
 * for some blobs when a single response gets too large, so we first probe each
 * file's byteSize (cheap, large batches) and then pack text requests so no query
 * exceeds `budget` bytes. This keeps results deterministic regardless of how
 * repos happen to group together.
 */
export async function fetchFilesAcrossRepos(
  requests,
  { duration, budget = 500_000, maxFileBytes = 1_000_000 } = {},
) {
  // Pass 1: probe byteSize (tiny responses, safe to batch large). Absent = no file.
  const sizes = new Map();
  for (const group of chunk(requests, 100)) {
    const data = await graphql(crossRepoQuery(group, "byteSize"), {}, duration);
    group.forEach((req, i) => {
      const size = data[`r${i}`]?.object?.byteSize;
      if (size != null) sizes.set(req.key, size);
    });
  }

  // Pass 2: fetch text, packing so each query stays under `budget` total bytes.
  // A file larger than the budget gets its own query; skip absurdly large ones.
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (const req of requests) {
    const size = sizes.get(req.key);
    if (size == null || size > maxFileBytes) continue;
    if (cur.length && curBytes + size > budget) {
      batches.push(cur);
      cur = [];
      curBytes = 0;
    }
    cur.push(req);
    curBytes += size;
  }
  if (cur.length) batches.push(cur);

  const texts = new Map();
  for (const group of batches) {
    const data = await graphql(crossRepoQuery(group, "text"), {}, duration);
    group.forEach((req, i) => {
      const text = data[`r${i}`]?.object?.text;
      if (text != null) texts.set(req.key, text);
    });
  }
  return texts;
}

// Fetch many files' text in batched GraphQL requests (~80 aliased blobs each).
async function fetchFileTexts(owner, name, paths, duration) {
  const texts = new Map();
  for (const group of chunk(paths, 80)) {
    const aliases = group
      .map(
        (p, i) =>
          `f${i}: object(expression:${JSON.stringify(`HEAD:${p}`)}){ ... on Blob { text } }`,
      )
      .join("\n");
    const query = `query{ repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){ ${aliases} } }`;
    const repoData = (await graphql(query, {}, duration)).repository || {};
    group.forEach((p, i) => {
      const text = repoData[`f${i}`]?.text;
      if (text != null) texts.set(p, text);
    });
  }
  return texts;
}

function workspaceGlobs(pkg) {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (Array.isArray(ws?.packages)) return ws.packages;
  return [];
}

// Resolve workspace globs to concrete directory paths. Supports exact paths and
// a single trailing "/*" (the common npm-workspaces shapes); skips deeper globs.
async function resolveWorkspaceDirs(owner, name, globs, duration) {
  const dirs = [];
  for (const glob of globs) {
    if (!glob.includes("*")) {
      dirs.push(glob.replace(/\/+$/, ""));
      continue;
    }
    const parent = glob.slice(0, glob.indexOf("*")).replace(/\/+$/, "");
    if (parent.includes("*")) continue; // nested/complex glob — skip
    const entries = await listDirEntries(owner, name, parent, duration);
    for (const e of entries) {
      if (e.type === "tree") dirs.push(`${parent}/${e.name}`);
    }
  }
  return dirs;
}

function normalizeRepo(repo) {
  let pkg = null;
  if (repo.packageJson?.text) {
    try {
      pkg = JSON.parse(repo.packageJson.text);
    } catch {
      pkg = null; // malformed package.json — treat as none
    }
  }
  return {
    nameWithOwner: repo.nameWithOwner,
    url: repo.url,
    homepageUrl: repo.homepageUrl || null,
    isArchived: repo.isArchived,
    isFork: repo.isFork,
    isPrivate: repo.isPrivate,
    isDisabled: repo.isDisabled,
    isTemplate: repo.isTemplate,
    repoCreatedAt: repo.createdAt,
    pushedAt: repo.pushedAt,
    stars: repo.stargazerCount,
    openIssues: repo.openIssues.totalCount,
    closedIssues: repo.closedIssues.totalCount,
    openPRs: repo.openPRs.totalCount,
    mergedPRs: repo.mergedPRs.totalCount,
    closedPRs: repo.closedPRs.totalCount,
    packageName: pkg?.name ?? null,
    isPrivatePackage: Boolean(pkg?.private),
    workspacePath: null,
    packageJson: pkg,
  };
}

/**
 * Expand a workspace monorepo into one entry per published workspace member.
 * Each member inherits the parent repo's GitHub metrics (stars/issues/PRs are
 * repo-level and can't be split per package) but carries its own package.json.
 */
async function expandWorkspaces(repo, duration) {
  const globs = workspaceGlobs(repo.packageJson);
  if (!globs.length) return [];
  // Members inherit the parent's flags, so if the parent would be filtered
  // structurally (fork/archived/private/disabled), skip the extra fetches.
  if (repo.isFork || repo.isArchived || repo.isPrivate || repo.isDisabled) return [];

  const [owner, name] = repo.nameWithOwner.split("/");
  const dirs = await resolveWorkspaceDirs(owner, name, globs, duration);
  const texts = await fetchFileTexts(
    owner,
    name,
    dirs.map((d) => `${d}/package.json`),
    duration,
  );

  const members = [];
  for (const [filePath, text] of texts) {
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      continue;
    }
    if (!pkg.name) continue; // unnamed workspace root/example — not a package
    members.push({
      ...repo,
      packageName: pkg.name,
      isPrivatePackage: Boolean(pkg.private),
      workspacePath: filePath.replace(/\/package\.json$/, ""),
      packageJson: pkg,
    });
  }
  return members;
}

/**
 * Discover candidate repos across the given users and orgs. Workspace monorepos
 * are expanded so each published workspace member becomes its own entry.
 * Returns normalized repo objects; filtering (archived/fork/private) is left to the caller.
 */
export async function discoverRepos(users = [], orgs = [], { duration } = {}) {
  const logins = [...users, ...orgs];
  const results = await Promise.all(
    logins.map((login) => reposForOwner(login, duration)),
  );

  const base = results.flat().map(normalizeRepo);
  const members = (
    await Promise.all(base.map((repo) => expandWorkspaces(repo, duration)))
  ).flat();
  return [...base, ...members];
}
