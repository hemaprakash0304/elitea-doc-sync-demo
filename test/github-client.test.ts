import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RunConfiguration } from "../src/config.js";
import {
  GitHubActionsAppCredentialProvider,
  LocalKeychainCredentialProvider,
} from "../src/github-credentials.js";
import { GitHubRestClient } from "../src/github-client.js";
import { GitHubReadError, type GitHubReadErrorCode } from "../src/github-errors.js";

const CONFIGURATION: RunConfiguration = {
  targetRepository: "Owner/Repo",
  normalizedRepositoryId: "owner/repo",
  executionContext: "local",
};

const PUBLIC_REPOSITORY = {
  id: 7,
  full_name: "owner/repo",
  private: false,
  default_branch: "trunk",
};

const PRIVATE_REPOSITORY = {
  ...PUBLIC_REPOSITORY,
  private: true,
  default_branch: "stable",
};

function jsonResponse(status: number, value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

async function errorOf(promise: Promise<unknown>, code: GitHubReadErrorCode): Promise<GitHubReadError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitHubReadError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected GitHub read error ${code}.`);
}

test("reads public metadata anonymously and discovers the declared default branch", async () => {
  let credentialCalls = 0;
  let requestUrl = "";
  const client = new GitHubRestClient({
    credentialProvider: {
      getReadToken: async () => {
        credentialCalls += 1;
        return undefined;
      },
    },
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      assert.equal(init?.method, "GET");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return jsonResponse(200, PUBLIC_REPOSITORY);
    },
  });

  const result = await client.getRepositoryMetadata(CONFIGURATION);

  assert.match(requestUrl, /\/repos\/Owner\/Repo$/);
  assert.equal(credentialCalls, 0);
  assert.deepEqual(result, {
    repositoryId: 7,
    normalizedRepositoryId: "owner/repo",
    fullName: "owner/repo",
    isPrivate: false,
    defaultBranch: "trunk",
    readRetryCount: 0,
  });
});

test("retries a hidden private repository with the credential provider", async () => {
  const authorizationHeaders: string[] = [];
  const readCredential = randomUUID();
  let callCount = 0;
  const client = new GitHubRestClient({
    credentialProvider: { getReadToken: async () => readCredential },
    fetchImplementation: async (_input, init) => {
      callCount += 1;
      authorizationHeaders.push(new Headers(init?.headers).get("Authorization") ?? "");
      return callCount === 1
        ? jsonResponse(404, { message: "Not Found" })
        : jsonResponse(200, PRIVATE_REPOSITORY);
    },
  });

  const result = await client.getRepositoryMetadata(CONFIGURATION);

  assert.equal(callCount, 2);
  assert.equal(authorizationHeaders[0], "");
  assert.match(authorizationHeaders[1] ?? "", /^Bearer /);
  assert.equal(result.isPrivate, true);
  assert.equal(result.defaultBranch, "stable");
});

test("loads local private credentials from the OS keychain by normalized repository ID", async () => {
  const localCredential = randomUUID();
  const provider = new LocalKeychainCredentialProvider(async () => ({
    getPassword: async (service, account) => {
      assert.equal(service, "automated-documentation-sync");
      assert.equal(account, "owner/repo");
      return localCredential;
    },
  }));

  assert.equal(await provider.getReadToken(CONFIGURATION), localCredential);
});

test("requests an Actions installation token for only the configured repository with read-only permissions", async () => {
  let requestUrl = "";
  let requestBody: unknown;
  let requestMethod = "";
  const appPrivateKey = randomUUID();
  const appJwt = randomUUID();
  const installationToken = randomUUID();
  const provider = new GitHubActionsAppCredentialProvider({
    environment: {
      DOCS_SYNC_READ_APP_ID: "123",
      DOCS_SYNC_READ_APP_INSTALLATION_ID: "456",
      DOCS_SYNC_READ_APP_PRIVATE_KEY: appPrivateKey,
    },
    nowSeconds: () => 1_800_000_000,
    signJwt: () => appJwt,
    fetchImplementation: async (input, init) => {
      requestUrl = String(input);
      requestMethod = init?.method ?? "";
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return jsonResponse(201, { token: installationToken });
    },
  });

  assert.equal(await provider.getReadToken(CONFIGURATION), installationToken);
  assert.match(requestUrl, /\/app\/installations\/456\/access_tokens$/);
  assert.equal(requestMethod, "POST");
  assert.deepEqual(requestBody, {
    repositories: ["Owner/Repo"],
    permissions: { metadata: "read", contents: "read" },
  });
  assert.doesNotMatch(JSON.stringify(requestBody), /write|pull_requests|administration/i);
});

test("maps missing repositories to a sanitized not-found error", async () => {
  const client = new GitHubRestClient({
    fetchImplementation: async () => jsonResponse(404, { message: "Not Found" }),
  });

  await errorOf(client.getRepositoryMetadata(CONFIGURATION), "REPOSITORY_NOT_FOUND");
});

test("maps authentication and authorization failures without retrying", async () => {
  for (const [status, code] of [
    [401, "AUTHENTICATION_FAILED"],
    [403, "AUTHORIZATION_FAILED"],
  ] as const) {
    let calls = 0;
    const readCredential = randomUUID();
    const client = new GitHubRestClient({
      maxReadAttempts: 3,
      credentialProvider: { getReadToken: async () => readCredential },
      fetchImplementation: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(404, {})
          : jsonResponse(status, { message: "synthetic authorization details" });
      },
    });

    const error = await errorOf(client.getRepositoryMetadata(CONFIGURATION), code);
    assert.equal(calls, 2);
    assert.doesNotMatch(error.message, /synthetic authorization details|token|Bearer/i);
  }
});

test("handles rate limiting and honors an immediate Retry-After before retrying", async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = new GitHubRestClient({
    fetchImplementation: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse(429, {}, { "retry-after": "0" })
        : jsonResponse(200, PUBLIC_REPOSITORY);
    },
    sleep: async (delay) => { delays.push(delay); },
  });

  const result = await client.getRepositoryMetadata(CONFIGURATION);
  assert.equal(result.defaultBranch, "trunk");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [0]);
  assert.equal(result.readRetryCount, 1);
});

test("fails closed on rate-limit exhaustion", async () => {
  let calls = 0;
  const client = new GitHubRestClient({
    maxReadAttempts: 2,
    fetchImplementation: async () => {
      calls += 1;
      return jsonResponse(429, {}, { "retry-after": "0" });
    },
    sleep: async () => {},
  });

  const error = await errorOf(client.getRepositoryMetadata(CONFIGURATION), "RATE_LIMITED");
  assert.equal(calls, 2);
  assert.equal(error.retryCount, 1);
});

test("retries transient network failures within the fixed attempt budget", async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = new GitHubRestClient({
    maxReadAttempts: 3,
    fetchImplementation: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("synthetic transient network failure");
      }
      return jsonResponse(200, PUBLIC_REPOSITORY);
    },
    sleep: async (delay) => { delays.push(delay); },
  });

  assert.equal((await client.getRepositoryMetadata(CONFIGURATION)).defaultBranch, "trunk");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("reports bounded network retry exhaustion without raw errors", async () => {
  let calls = 0;
  const client = new GitHubRestClient({
    maxReadAttempts: 100,
    fetchImplementation: async () => {
      calls += 1;
      throw new Error("synthetic network details with private data");
    },
    sleep: async () => {},
  });

  const error = await errorOf(client.getRepositoryMetadata(CONFIGURATION), "NETWORK_FAILURE");
  assert.equal(calls, 3);
  assert.equal(error.retryCount, 2);
  assert.doesNotMatch(error.message, /synthetic network details|private data/);
});

test("returns a typed error when the default branch is absent", async () => {
  const client = new GitHubRestClient({
    fetchImplementation: async () => jsonResponse(200, { ...PUBLIC_REPOSITORY, default_branch: "" }),
  });

  await errorOf(client.getRepositoryMetadata(CONFIGURATION), "DEFAULT_BRANCH_MISSING");
});

test("resolves the requested default-branch name to a commit and tree SHA", async () => {
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  let requestUrl = "";
  const client = new GitHubRestClient({
    fetchImplementation: async (input) => {
      requestUrl = String(input);
      return jsonResponse(200, {
        name: "release/2026",
        commit: {
          sha: commitSha,
          commit: { tree: { sha: treeSha } },
        },
      });
    },
  });

  const snapshot = await client.getDefaultBranchCommit(CONFIGURATION, "release/2026");

  assert.match(requestUrl, /\/branches\/release%2F2026$/);
  assert.deepEqual(snapshot, {
    branch: "release/2026",
    commitSha,
    treeSha,
    readRetryCount: 0,
  });
});

test("reads recursive trees and blobs by immutable object SHA", async () => {
  const treeSha = "c".repeat(40);
  const blobSha = "d".repeat(40);
  const blobBytes = Buffer.from("safe source fixture", "utf8");
  const requestedUrls: string[] = [];
  const client = new GitHubRestClient({
    fetchImplementation: async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/git/trees/")) {
        return jsonResponse(200, {
          sha: treeSha,
          truncated: false,
          tree: [{ path: "src/main.ts", mode: "100644", type: "blob", sha: blobSha, size: blobBytes.length }],
        });
      }
      return jsonResponse(200, {
        sha: blobSha,
        size: blobBytes.length,
        encoding: "base64",
        content: blobBytes.toString("base64"),
      });
    },
  });

  const tree = await client.getRepositoryTree(CONFIGURATION, treeSha);
  const blob = await client.getGitBlob(CONFIGURATION, blobSha);

  assert.match(requestedUrls[0] ?? "", new RegExp(`/git/trees/${treeSha}\\?recursive=1$`));
  assert.match(requestedUrls[1] ?? "", new RegExp(`/git/blobs/${blobSha}$`));
  assert.equal(tree.entries[0]?.sha, blob.sha);
  assert.equal(Buffer.from(blob.content, "base64").toString("utf8"), "safe source fixture");
});

test("types missing commit, tree, and blob responses and rejects incomplete trees", async () => {
  const branchClient = new GitHubRestClient({ fetchImplementation: async () => jsonResponse(404, {}) });
  await errorOf(
    branchClient.getDefaultBranchCommit(CONFIGURATION, "trunk"),
    "DEFAULT_BRANCH_COMMIT_MISSING",
  );

  const treeSha = "3".repeat(40);
  const treeClient = new GitHubRestClient({ fetchImplementation: async () => jsonResponse(404, {}) });
  await errorOf(treeClient.getRepositoryTree(CONFIGURATION, treeSha), "TREE_RETRIEVAL_FAILED");

  const blobSha = "4".repeat(40);
  const blobClient = new GitHubRestClient({ fetchImplementation: async () => jsonResponse(404, {}) });
  await errorOf(blobClient.getGitBlob(CONFIGURATION, blobSha), "BLOB_RETRIEVAL_FAILED");

  const incompleteTreeClient = new GitHubRestClient({
    fetchImplementation: async () => jsonResponse(200, { sha: treeSha, tree: [] }),
  });
  await errorOf(incompleteTreeClient.getRepositoryTree(CONFIGURATION, treeSha), "INVALID_RESPONSE");
});

test("fails closed when GitHub reports a truncated recursive tree", async () => {
  const treeSha = "5".repeat(40);
  const client = new GitHubRestClient({
    fetchImplementation: async () => jsonResponse(200, { sha: treeSha, truncated: true, tree: [] }),
  });

  await errorOf(client.getRepositoryTree(CONFIGURATION, treeSha), "SNAPSHOT_INCONSISTENT");
});

test("uses the raw blob media type when GitHub omits base64 for a large blob", async () => {
  const blobSha = "2".repeat(40);
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0x61);
  const accepts: string[] = [];
  let requests = 0;
  const client = new GitHubRestClient({
    fetchImplementation: async (_input, init) => {
      requests += 1;
      accepts.push(new Headers(init?.headers).get("Accept") ?? "");
      return requests === 1
        ? jsonResponse(200, { sha: blobSha, size: bytes.length, encoding: "none", content: "" })
        : new Response(bytes, { status: 200 });
    },
  });

  const blob = await client.getGitBlob(CONFIGURATION, blobSha);

  assert.equal(requests, 2);
  assert.equal(accepts[0], "application/vnd.github+json");
  assert.equal(accepts[1], "application/vnd.github.raw");
  assert.equal(blob.size, bytes.length);
  assert.equal(Buffer.from(blob.content, "base64").equals(bytes), true);
});

test("reuses the exact-target read token for snapshot and blob requests", async () => {
  const commitSha = "e".repeat(40);
  const treeSha = "f".repeat(40);
  const blobSha = "1".repeat(40);
  const tokenValue = randomUUID();
  let credentialCalls = 0;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const client = new GitHubRestClient({
    credentialProvider: {
      getReadToken: async () => {
        credentialCalls += 1;
        return tokenValue;
      },
    },
    fetchImplementation: async (input, init) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      requests.push({ url, authorization });
      if (requests.length === 1) {
        return jsonResponse(404, {});
      }
      if (url.endsWith("/repos/Owner/Repo")) {
        return jsonResponse(200, PUBLIC_REPOSITORY);
      }
      if (url.includes("/branches/")) {
        return jsonResponse(200, {
          name: "trunk",
          commit: { sha: commitSha, commit: { tree: { sha: treeSha } } },
        });
      }
      if (url.includes("/git/trees/")) {
        return jsonResponse(200, { sha: treeSha, truncated: false, tree: [] });
      }
      return jsonResponse(200, { sha: blobSha, size: 0, encoding: "base64", content: "" });
    },
  });

  await client.getRepositoryMetadata(CONFIGURATION);
  await client.getDefaultBranchCommit(CONFIGURATION, "trunk");
  await client.getRepositoryTree(CONFIGURATION, treeSha);
  await client.getGitBlob(CONFIGURATION, blobSha);

  assert.equal(credentialCalls, 1);
  assert.equal(requests[0]?.authorization, null);
  assert.ok(requests.slice(1).every((request) => request.authorization === `Bearer ${tokenValue}`));
});

test("rejects malformed metadata without exposing the response body", async () => {
  const responseProbe = randomUUID();
  const client = new GitHubRestClient({
    fetchImplementation: async () => jsonResponse(200, {
      id: "not-a-number",
      full_name: "owner/repo",
      private: false,
      default_branch: "trunk",
      response_marker: responseProbe,
    }),
  });

  const error = await errorOf(client.getRepositoryMetadata(CONFIGURATION), "INVALID_RESPONSE");
  assert.doesNotMatch(error.message, new RegExp(responseProbe));
});

test("sanitizes authentication failures and does not include credential material", async () => {
  const syntheticSensitiveValue = randomUUID();
  const client = new GitHubRestClient({
    credentialProvider: { getReadToken: async () => syntheticSensitiveValue },
    fetchImplementation: async (_input, init) => {
      if (new Headers(init?.headers).has("Authorization")) {
        return jsonResponse(401, { message: syntheticSensitiveValue });
      }
      return jsonResponse(404, {});
    },
  });

  const error = await errorOf(client.getRepositoryMetadata(CONFIGURATION), "AUTHENTICATION_FAILED");
  assert.doesNotMatch(JSON.stringify(error), new RegExp(syntheticSensitiveValue));
});