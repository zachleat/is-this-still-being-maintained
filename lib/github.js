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
        isArchived
        isFork
        isPrivate
        isDisabled
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

/**
 * Discover candidate repos across the given users and orgs.
 * Returns normalized repo objects; filtering (archived/fork/private) is left to the caller.
 */
export async function discoverRepos(users = [], orgs = [], { duration } = {}) {
  const logins = [...users, ...orgs];
  const results = await Promise.all(
    logins.map((login) => reposForOwner(login, duration)),
  );

  return results.flat().map((repo) => {
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
      isArchived: repo.isArchived,
      isFork: repo.isFork,
      isPrivate: repo.isPrivate,
      isDisabled: repo.isDisabled,
      pushedAt: repo.pushedAt,
      stars: repo.stargazerCount,
      openIssues: repo.openIssues.totalCount,
      closedIssues: repo.closedIssues.totalCount,
      openPRs: repo.openPRs.totalCount,
      mergedPRs: repo.mergedPRs.totalCount,
      closedPRs: repo.closedPRs.totalCount,
      packageName: pkg?.name ?? null,
      isPrivatePackage: Boolean(pkg?.private),
      packageJson: pkg,
    };
  });
}
