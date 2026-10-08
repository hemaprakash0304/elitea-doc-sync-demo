import assert from "node:assert/strict";
import test from "node:test";
import type { RunConfiguration } from "../src/config.js";
import type { GitHubRepositoryMetadata } from "../src/github-client.js";
import { TECHNICAL_PROFILE_PATH } from "../src/collection.js";
import { createGitHubProposalWriteClient, type ProposalAppEnvironment } from "../src/github-proposal-client.js";
import type { ProposalWriteClient } from "../src/proposal.js";

const CONFIGURATION: RunConfiguration = {
  targetRepository: "Sample/Proposal-Fixture",
  normalizedRepositoryId: "sample/proposal-fixture",
  executionContext: "actions",
};
const REPOSITORY: GitHubRepositoryMetadata = {
  repositoryId: 88,
  normalizedRepositoryId: CONFIGURATION.normalizedRepositoryId,
  fullName: CONFIGURATION.targetRepository,
  isPrivate: true,
  defaultBranch: "release/next",
  readRetryCount: 0,
};
const SNAPSHOT_SHA = "a".repeat(40);
const BRANCH_NAME = "docs-sync/technical-profile/00000000-0000-4000-8000-000000000001-abcdef123456";
const SYNTHETIC_KEY = "SYNTHETIC_ONLY_PRIVATE_KEY_NOT_A_CREDENTIAL";
const SYNTHETIC_TOKEN = "SYNTHETIC_ONLY_INSTALLATION_TOKEN_NOT_A_CREDENTIAL";
const CANDIDATE_DIGEST = `abcdef123456${"0".repeat(52)}`;

function environment(): ProposalAppEnvironment {
  return {
    DOCS_SYNC_PROPOSAL_APP_ID: "12345",
    DOCS_SYNC_PROPOSAL_APP_INSTALLATION_ID: "67890",
    DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY: SYNTHETIC_KEY,
    DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED: "true",
  };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function proposalClient(fetchImplementation: typeof fetch): ProposalWriteClient {
  const client = createGitHubProposalWriteClient(CONFIGURATION, REPOSITORY, environment(), {
    fetchImplementation,
    nowSeconds: () => 1_800_000_000,
    signJwt: () => "SYNTHETIC_ONLY_APP_JWT_NOT_A_CREDENTIAL",
  });
  assert.ok(client);
  return client;
}

test("creates a target-scoped feature branch, one-file commit, and review PR without other write operations", async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const branchObject = { ref: `refs/heads/${BRANCH_NAME}`, object: { sha: SNAPSHOT_SHA } };
  const commitSha = "c".repeat(40);
  const treeSha = "d".repeat(40);
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, ...(body === undefined ? {} : { body }) });

    if (url.includes("/app/installations/67890/access_tokens")) return response(201, { token: SYNTHETIC_TOKEN });
    if (method === "GET" && url.endsWith("/pulls?state=open&per_page=100")) return response(200, []);
    if (method === "POST" && url.endsWith("/git/refs")) return response(201, branchObject);
    if (method === "POST" && url.endsWith("/git/blobs")) return response(201, { sha: "b".repeat(40) });
    if (method === "POST" && url.endsWith("/git/trees")) return response(201, { sha: treeSha });
    if (method === "POST" && url.endsWith("/git/commits")) {
      return response(201, { sha: commitSha, tree: { sha: treeSha }, parents: [{ sha: SNAPSHOT_SHA }] });
    }
    if (method === "PATCH" && url.includes("/git/refs/heads/")) {
      return response(200, { ref: branchObject.ref, object: { sha: commitSha } });
    }
    if (method === "GET" && url.includes("/git/ref/heads/")) {
      return response(200, { ref: branchObject.ref, object: { sha: commitSha } });
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      const request = JSON.parse(body ?? "{}") as { head: string; base: string };
      return response(201, {
        number: 12,
        html_url: "https://github.com/Sample/Proposal-Fixture/pull/12",
        state: "open",
        head: { ref: request.head },
        base: { ref: request.base },
      });
    }
    if (method === "PATCH" && url.endsWith("/pulls/12")) return response(200, { state: "closed" });
    return response(500, { message: "SYNTHETIC_ONLY_UNEXPECTED_ENDPOINT" });
  };

  const client = proposalClient(fetchImplementation);
  const branch = await client.createFeatureBranch({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    branchName: BRANCH_NAME,
    baseBranch: REPOSITORY.defaultBranch,
    baseCommitSha: SNAPSHOT_SHA,
    candidateSha256: CANDIDATE_DIGEST,
    signal: new AbortController().signal,
  }).catch((error: Error) => {
    assert.fail(`${error.message}; fake requests=${JSON.stringify(calls.map(({ url, method }) => ({ url, method })))}`);
  });
  assert.equal(branch.status, "CREATED");

  const candidate = "# Technical Profile\nSynthetic fixture only.\n";
  const commit = await client.commitSingleProfileFile({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    branchName: BRANCH_NAME,
    baseCommitSha: SNAPSHOT_SHA,
    baseTreeSha: "e".repeat(40),
    path: TECHNICAL_PROFILE_PATH,
    content: candidate,
    commitMessage: "docs: update technical profile",
    signal: new AbortController().signal,
  });
  assert.equal(commit.commitSha, commitSha);
  assert.deepEqual(commit.changedPaths, [TECHNICAL_PROFILE_PATH]);

  const branchHead = await client.getBranchHead({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    branchName: BRANCH_NAME,
    signal: new AbortController().signal,
  });
  assert.equal(branchHead.commitSha, commitSha);

  const pullRequest = await client.createPullRequest({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    headBranch: BRANCH_NAME,
    baseBranch: REPOSITORY.defaultBranch,
    title: "docs: update technical profile",
    body: "Gate: PASS",
    signal: new AbortController().signal,
  });
  assert.equal(pullRequest.state, "open");
  assert.equal(pullRequest.baseBranch, REPOSITORY.defaultBranch);
  assert.equal(await client.closePullRequest({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    pullRequestNumber: 12,
    signal: new AbortController().signal,
  }), true);

  const tokenRequest = JSON.parse(calls[0]?.body ?? "{}") as {
    repositories: string[];
    permissions: Record<string, string>;
  };
  assert.deepEqual(tokenRequest.repositories, [REPOSITORY.fullName]);
  assert.deepEqual(tokenRequest.permissions, { metadata: "read", contents: "write", pull_requests: "write" });
  const refCreation = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/refs"));
  assert.deepEqual(JSON.parse(refCreation?.body ?? "{}"), { ref: `refs/heads/${BRANCH_NAME}`, sha: SNAPSHOT_SHA });
  const treeRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/trees"));
  const treeBody = JSON.parse(treeRequest?.body ?? "{}") as { tree: Array<{ path: string }> };
  assert.deepEqual(treeBody.tree.map((entry) => entry.path), [TECHNICAL_PROFILE_PATH]);
  const pullRequestRequest = calls.find((call) => call.method === "POST" && call.url.endsWith("/pulls"));
  const pullRequestBody = JSON.parse(pullRequestRequest?.body ?? "{}") as Record<string, unknown>;
  assert.equal(pullRequestBody.base, REPOSITORY.defaultBranch);
  assert.equal("auto_merge" in pullRequestBody, false);
  assert.equal(calls.length, 10);
  assert.equal(calls.some((call) => /\/reviews(?:\/|$)|\/merges(?:\/|$)/.test(call.url)), false);
  assert.equal(calls.some((call) => /\/git\/refs\/heads\/(?:main|master|trunk)$/.test(call.url)), false);
  assert.doesNotMatch(JSON.stringify(calls), /SYNTHETIC_ONLY_PRIVATE_KEY_NOT_A_CREDENTIAL/);

  let collisionWriteRequests = 0;
  const collisionClient = proposalClient(async (input) => {
    if (String(input).includes("/app/installations/67890/access_tokens")) return response(201, { token: SYNTHETIC_TOKEN });
    if (String(input).endsWith("/pulls?state=open&per_page=100")) return response(200, []);
    collisionWriteRequests += 1;
    return response(422, { message: "SYNTHETIC_ONLY_BRANCH_COLLISION_RESPONSE" });
  });
  const collision = await collisionClient.createFeatureBranch({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    branchName: BRANCH_NAME,
    baseBranch: REPOSITORY.defaultBranch,
    baseCommitSha: SNAPSHOT_SHA,
    candidateSha256: CANDIDATE_DIGEST,
    signal: new AbortController().signal,
  });
  assert.equal(collision.status, "ALREADY_EXISTS");
  assert.equal(collisionWriteRequests, 1);

  let duplicateBranchWrites = 0;
  const existingProposalClient = proposalClient(async (input, init) => {
    if (String(input).includes("/app/installations/67890/access_tokens")) return response(201, { token: SYNTHETIC_TOKEN });
    if (String(input).endsWith("/pulls?state=open&per_page=100")) {
      return response(200, [{
        state: "open",
        title: "docs: update technical profile",
        body: `- Snapshot: ${SNAPSHOT_SHA.slice(0, 12)}\n- Profile digest: ${CANDIDATE_DIGEST}`,
        head: { ref: "docs-sync/technical-profile/previous-run-abcdef123456", repo: { full_name: REPOSITORY.fullName } },
        base: { ref: REPOSITORY.defaultBranch },
      }]);
    }
    if (init?.method === "POST" && String(input).endsWith("/git/refs")) duplicateBranchWrites += 1;
    return response(500, {});
  });
  const existingProposal = await existingProposalClient.createFeatureBranch({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    branchName: BRANCH_NAME,
    baseBranch: REPOSITORY.defaultBranch,
    baseCommitSha: SNAPSHOT_SHA,
    candidateSha256: CANDIDATE_DIGEST,
    signal: new AbortController().signal,
  });
  assert.equal(existingProposal.failureCode, "OPEN_PROPOSAL_EXISTS");
  assert.equal(duplicateBranchWrites, 0);
});

test("requires Actions context, exact target, and explicit branch-protection confirmation", () => {
  assert.equal(createGitHubProposalWriteClient({ ...CONFIGURATION, executionContext: "local" }, REPOSITORY, environment()), undefined);
  assert.equal(createGitHubProposalWriteClient(CONFIGURATION, REPOSITORY, {}), undefined);
  assert.equal(createGitHubProposalWriteClient(CONFIGURATION, REPOSITORY, {
    ...environment(),
    DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED: "false",
  }), undefined);
  assert.equal(createGitHubProposalWriteClient(CONFIGURATION, {
    ...REPOSITORY,
    fullName: "Other/Repository",
  }, environment()), undefined);
});

test("does not retry a failed branch write or expose raw API error content", async () => {
  const calls: string[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (String(input).includes("/app/installations/67890/access_tokens")) return response(201, { token: SYNTHETIC_TOKEN });
    if (String(input).endsWith("/pulls?state=open&per_page=100")) return response(200, []);
    return response(500, { message: "SYNTHETIC_ONLY_RESPONSE_SECRET_NOT_TO_LOG" });
  };
  const client = proposalClient(fetchImplementation);

  await assert.rejects(client.createFeatureBranch({
    repositoryId: REPOSITORY.repositoryId,
    repositoryFullName: REPOSITORY.fullName,
    branchName: BRANCH_NAME,
    baseBranch: REPOSITORY.defaultBranch,
    baseCommitSha: SNAPSHOT_SHA,
    candidateSha256: CANDIDATE_DIGEST,
    signal: new AbortController().signal,
  }), (error: Error) => {
    assert.doesNotMatch(error.message, /SYNTHETIC_ONLY_RESPONSE_SECRET_NOT_TO_LOG/);
    return true;
  });
  assert.equal(calls.length, 3);
});
