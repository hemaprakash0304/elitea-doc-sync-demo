import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { composeTechnicalProfile } from "../src/composer.js";
import { TECHNICAL_PROFILE_PATH, type ExistingProfileInput } from "../src/collection.js";
import type { RunConfiguration } from "../src/config.js";
import {
  AUTOMATED_TEST_SUITE_VERSION,
  evaluateMandatoryGate,
  type AutomatedTestResult,
  type ProposalAuthorization,
} from "../src/gate.js";
import type { GitHubCommitSnapshot, GitHubReadClient, GitHubRepositoryMetadata } from "../src/github-client.js";
import { GitHubReadError } from "../src/github-errors.js";
import { buildEvidenceCatalog } from "../src/evidence/catalog.js";
import type { RepositoryFilterResult, SecretScanInputFile, SecretScanOutcome, SecretScanner } from "../src/filter.js";
import {
  submitTechnicalProfileProposal,
  type ProposalBranchResult,
  type ProposalCommitResult,
  type ProposalInput,
  type ProposalPullRequestResult,
  type ProposalResult,
  type ProposalWriteCapability,
  type ProposalWriteClient,
} from "../src/proposal.js";
import { reconcileTechnicalProfile } from "../src/reconciler.js";
import { validateReconciledCandidate } from "../src/validation.js";

const CONFIGURATION: RunConfiguration = {
  targetRepository: "Sample/Proposal-Fixture",
  normalizedRepositoryId: "sample/proposal-fixture",
  executionContext: "local",
};
const REPOSITORY: GitHubRepositoryMetadata = {
  repositoryId: 88,
  normalizedRepositoryId: CONFIGURATION.normalizedRepositoryId,
  fullName: "Sample/Proposal-Fixture",
  isPrivate: false,
  defaultBranch: "release/next",
  readRetryCount: 0,
};
const SNAPSHOT: GitHubCommitSnapshot = {
  branch: REPOSITORY.defaultBranch,
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  readRetryCount: 0,
};
const RUN_ID = "run-00000000-0000-4000-8000-000000000014";
const SCANNER_VERSION = "test-double/1";
const TEST_RESULT_BASE = {
  status: "PASS" as const,
  suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
  totalTests: 213,
  passedTests: 213,
  failedTests: 0,
  skippedTests: 0,
};

class PassingScanner implements SecretScanner {
  readonly id = "test_double" as const;
  readonly executionBoundary = "local" as const;
  readonly version = SCANNER_VERSION;

  async scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    return { status: "complete", scannedFileCount: files.length, findings: [] };
  }
}

class FakeProposalWriteClient implements ProposalWriteClient {
  readonly capability: ProposalWriteCapability = {
    provider: "dedicated_github_proposal_app",
    normalizedRepositoryId: CONFIGURATION.normalizedRepositoryId,
    repositoryId: REPOSITORY.repositoryId,
    permissions: {
      contents: "write",
      pullRequests: "write",
      canApprove: false,
      canMerge: false,
      canBypassBranchProtection: false,
      canWriteDefaultBranch: false,
    },
    branchProtection: {
      pullRequestRequired: true,
      humanApprovalRequired: true,
      proposalAppBypass: false,
    },
  };
  readonly calls: Array<{ method: string; input?: unknown }> = [];
  branchResult: ProposalBranchResult = {
    status: "CREATED",
    branchName: "",
    baseCommitSha: SNAPSHOT.commitSha,
  };
  commitResult?: ProposalCommitResult;
  pullRequestResult?: ProposalPullRequestResult;
  pullRequestBaseBranch?: string;
  changedPaths = [TECHNICAL_PROFILE_PATH];

  async createFeatureBranch(input: Parameters<ProposalWriteClient["createFeatureBranch"]>[0]): Promise<ProposalBranchResult> {
    this.calls.push({ method: "createFeatureBranch", input });
    return { ...this.branchResult, branchName: input.branchName };
  }

  async commitSingleProfileFile(input: Parameters<ProposalWriteClient["commitSingleProfileFile"]>[0]): Promise<ProposalCommitResult> {
    this.calls.push({ method: "commitSingleProfileFile", input });
    return this.commitResult ?? {
      commitSha: "c".repeat(40),
      parentCommitSha: input.baseCommitSha,
      treeSha: "d".repeat(40),
      changedPaths: [...this.changedPaths],
      profileSha256: sha256(input.content),
    };
  }

  async getBranchHead(input: Parameters<ProposalWriteClient["getBranchHead"]>[0]): Promise<{ branchName: string; commitSha: string }> {
    this.calls.push({ method: "getBranchHead", input });
    return { branchName: input.branchName, commitSha: "c".repeat(40) };
  }

  async createPullRequest(input: Parameters<ProposalWriteClient["createPullRequest"]>[0]): Promise<ProposalPullRequestResult> {
    this.calls.push({ method: "createPullRequest", input });
    return this.pullRequestResult ?? {
      number: 7,
      url: "https://github.com/Sample/Proposal-Fixture/pull/7",
      state: "open",
      headBranch: input.headBranch,
      baseBranch: this.pullRequestBaseBranch ?? input.baseBranch,
    };
  }

  async closePullRequest(input: Parameters<ProposalWriteClient["closePullRequest"]>[0]): Promise<boolean> {
    this.calls.push({ method: "closePullRequest", input });
    return true;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function assertSingleProposalAttempt(writer: FakeProposalWriteClient): void {
  for (const method of ["createFeatureBranch", "commitSingleProfileFile", "createPullRequest"]) {
    assert.equal(writer.calls.filter((call) => call.method === method).length, 1, method);
  }
}

function makeReadClient(options: { currentCommitSha?: string; metadata?: GitHubRepositoryMetadata } = {}): GitHubReadClient & { calls: string[] } {
  const calls: string[] = [];
  const metadata = options.metadata ?? REPOSITORY;
  return {
    calls,
    getRepositoryMetadata: async () => {
      calls.push("getRepositoryMetadata");
      return metadata;
    },
    getDefaultBranchCommit: async (_configuration, branch) => {
      calls.push(`getDefaultBranchCommit:${branch}`);
      return {
        ...SNAPSHOT,
        branch,
        commitSha: options.currentCommitSha ?? SNAPSHOT.commitSha,
      };
    },
    getRepositoryTree: async () => ({ treeSha: SNAPSHOT.treeSha, entries: [], truncated: false, readRetryCount: 0 }),
    getGitBlob: async () => { throw new Error("Unexpected read client blob call in proposal test."); },
  };
}

async function makeProposalInput(options: {
  noChanges?: boolean;
  currentCommitSha?: string;
  withWriter?: boolean;
} = {}): Promise<ProposalInput & { writeClient: FakeProposalWriteClient; readClient: GitHubReadClient & { calls: string[] } }> {
  const profileMode = options.noChanges === true;
  const filtered: RepositoryFilterResult = {
    status: "ready",
    repositoryId: CONFIGURATION.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT.commitSha,
    analysisFiles: [],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: {
      status: "complete",
      scanner: "test_double",
      expectedFileCount: profileMode ? 1 : 0,
      scannedFileCount: profileMode ? 1 : 0,
      coverageComplete: true,
    },
    existingProfile: profileMode ? { status: "safe_to_parse" } : { status: "absent" },
  };
  const observations = profileMode ? [{
    analyzer: "javascript_node" as const,
    category: "package_name" as const,
    name: "Package name",
    value: "proposal-app",
    source: { path: "package.json", locator: "package.json:name", kind: "manifest" as const },
    claimType: "declaration" as const,
    status: "Verified" as const,
    verificationBasis: "manifest_declaration" as const,
    confidence: "High" as const,
  }] : [];
  const catalog = buildEvidenceCatalog(filtered, {
    repositoryId: CONFIGURATION.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT.commitSha,
    observations,
    issues: [],
  }, { repositoryFullName: REPOSITORY.fullName });
  const composition = composeTechnicalProfile(catalog);
  let existingProfile: ExistingProfileInput = { profilePresent: false };
  if (profileMode) {
    const bytes = Buffer.from(composition.candidate, "utf8");
    existingProfile = {
      profilePresent: true,
      file: {
        path: TECHNICAL_PROFILE_PATH,
        extension: ".md",
        mode: "100644",
        kind: "regular",
        size: bytes.length,
        blobSha: "e".repeat(40),
        sourceCommitSha: SNAPSHOT.commitSha,
        contentStatus: "text",
        content: composition.candidate,
      },
    };
  }
  const reconciliation = reconcileTechnicalProfile(filtered, existingProfile, catalog, composition);
  const validation = await validateReconciledCandidate({
    filtered,
    catalog,
    composition,
    reconciliation,
    scanner: new PassingScanner(),
  });
  assert.equal(validation.status, "PASS");
  const automatedTests: AutomatedTestResult = {
    ...TEST_RESULT_BASE,
    binding: {
      runId: RUN_ID,
      targetRepository: CONFIGURATION.normalizedRepositoryId,
      snapshotCommitSha: SNAPSHOT.commitSha,
      candidateSha256: reconciliation.candidateSha256 as string,
      schemaVersion: 1,
    },
  };
  const gate = evaluateMandatoryGate({
    runId: RUN_ID,
    configuration: CONFIGURATION,
    repository: REPOSITORY,
    filtered,
    catalog,
    composition,
    reconciliation,
    validation,
    automatedTests,
    scannerVersion: SCANNER_VERSION,
    changedFilePaths: reconciliation.status === "NO_CHANGES" ? [] : [TECHNICAL_PROFILE_PATH],
  });
  const authorization = gate.proposalAuthorization;
  const writeClient = new FakeProposalWriteClient();
  const readClient = makeReadClient(options.currentCommitSha === undefined ? {} : { currentCommitSha: options.currentCommitSha });
  return {
    runId: RUN_ID,
    configuration: CONFIGURATION,
    repository: REPOSITORY,
    filtered,
    snapshot: SNAPSHOT,
    composition,
    reconciliation,
    gate,
    ...(authorization === undefined ? {} : { authorization }),
    scannerVersion: SCANNER_VERSION,
    readClient,
    writeClient,
  };
}

test("creates a snapshot-based feature branch, single-file commit, and human-review PR after authorization", async () => {
  const input = await makeProposalInput();
  const result = await submitTechnicalProfileProposal(input);

  assert.equal(input.gate.status, "PASS");
  assert.equal(result.status, "CREATED");
  assert.deepEqual(result.changedFiles, [TECHNICAL_PROFILE_PATH]);
  assert.equal(result.branchName, `docs-sync/technical-profile/${RUN_ID.slice(4)}-${result.candidateSha256.slice(0, 12)}`);
  assert.equal(result.commitSha, "c".repeat(40));
  assert.equal(result.pullRequest?.number, 7);
  assert.deepEqual(input.writeClient.calls.map((call) => call.method), [
    "createFeatureBranch", "commitSingleProfileFile", "getBranchHead", "createPullRequest",
  ]);
  const branchRequest = input.writeClient.calls[0]?.input as { baseCommitSha: string; baseBranch: string };
  const commitRequest = input.writeClient.calls[1]?.input as { baseCommitSha: string; path: string; content: string; commitMessage: string };
  const pullRequestRequest = input.writeClient.calls[3]?.input as { headBranch: string; baseBranch: string; body: string };
  assert.equal(branchRequest.baseCommitSha, SNAPSHOT.commitSha);
  assert.equal(branchRequest.baseBranch, REPOSITORY.defaultBranch);
  assert.equal(commitRequest.baseCommitSha, SNAPSHOT.commitSha);
  assert.equal(commitRequest.path, TECHNICAL_PROFILE_PATH);
  assert.equal(commitRequest.content, input.reconciliation.candidate);
  assert.equal(commitRequest.commitMessage, "docs: update technical profile");
  assert.equal(pullRequestRequest.headBranch, result.branchName);
  assert.equal(pullRequestRequest.baseBranch, REPOSITORY.defaultBranch);
  assert.match(pullRequestRequest.body, /Gate: PASS/);
  assert.match(pullRequestRequest.body, /Snapshot: a{40}/);
  assert.match(pullRequestRequest.body, new RegExp(`Profile digest: ${result.candidateSha256}`));
  assert.doesNotMatch(pullRequestRequest.body, /password|token|private key/i);
  assert.equal("credential" in input.writeClient, false);
});

test("rejects a stale default-branch head before any GitHub write", async () => {
  const input = await makeProposalInput({ currentCommitSha: "f".repeat(40) });
  const result = await submitTechnicalProfileProposal(input);

  assert.equal(result.status, "STALE");
  assert.equal(result.failureCode, "STALE_SNAPSHOT");
  assert.deepEqual(input.writeClient.calls, []);
  assert.deepEqual(input.readClient.calls, ["getRepositoryMetadata", `getDefaultBranchCommit:${REPOSITORY.defaultBranch}`]);
});

test("blocks missing, mismatched, malformed, or unscoped authorization before reads or writes", async (t) => {
  type ProposalFixture = Awaited<ReturnType<typeof makeProposalInput>>;
  const cases: Array<[string, (base: ProposalFixture, writer: FakeProposalWriteClient) => ProposalInput, string]> = [
    ["missing authorization", (base, writer) => {
      const input: ProposalInput = { ...base, writeClient: writer };
      delete input.authorization;
      return input;
    }, "AUTHORIZATION_MISSING"],
    ["different repository", (base, writer) => ({
      ...base,
      configuration: { ...base.configuration, normalizedRepositoryId: "other/repository" },
      writeClient: writer,
    }), "TARGET_BINDING_MISMATCH"],
    ["wrong candidate digest", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, candidateSha256: "0".repeat(64) },
      },
      writeClient: writer,
    }), "CANDIDATE_DIGEST_MISMATCH"],
    ["different run ID", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, runId: "run-00000000-0000-4000-8000-000000000099" },
      },
      writeClient: writer,
    }), "AUTHORIZATION_INVALID"],
    ["different GitHub repository ID", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, githubRepositoryId: 99 },
      },
      writeClient: writer,
    }), "TARGET_BINDING_MISMATCH"],
    ["different snapshot SHA", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, snapshotCommitSha: "f".repeat(40) },
      },
      writeClient: writer,
    }), "SNAPSHOT_BINDING_MISMATCH"],
    ["different schema version", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, schemaVersion: 2 },
      },
      writeClient: writer,
    }), "SCHEMA_UNSUPPORTED"],
    ["different validator version", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, validatorVersion: "IMP-99/1" },
      },
      writeClient: writer,
    }), "AUTHORIZATION_INVALID"],
    ["different test-suite version", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, testSuiteVersion: "IMP-99/1" },
      },
      writeClient: writer,
    }), "AUTHORIZATION_INVALID"],
    ["different scanner binding", (base, writer) => ({
      ...base,
      authorization: {
        ...base.authorization as ProposalAuthorization,
        binding: { ...(base.authorization as ProposalAuthorization).binding, scannerVersion: "other-scanner/2" },
      },
      writeClient: writer,
    }), "AUTHORIZATION_INVALID"],
    ["wrong artifact path", (base, writer) => ({
      ...base,
      authorization: { ...base.authorization as ProposalAuthorization, allowedArtifactPath: "README.md" as typeof TECHNICAL_PROFILE_PATH },
      writeClient: writer,
    }), "ARTIFACT_PATH_INVALID"],
    ["gate not passed", (base, writer) => ({
      ...base,
      gate: { ...base.gate, status: "BLOCKED" },
      writeClient: writer,
    }), "GATE_NOT_PASSED"],
    ["write client scoped to another repository", (base, writer) => {
      Object.assign(writer, { capability: { ...writer.capability, repositoryId: 99 } });
      return { ...base, writeClient: writer };
    }, "PROPOSAL_CAPABILITY_SCOPE_MISMATCH"],
    ["write client with merge permission", (base, writer) => {
      Object.assign(writer, { capability: {
        ...writer.capability,
        permissions: { ...writer.capability.permissions, canMerge: true },
      } });
      return { ...base, writeClient: writer };
    }, "PROPOSAL_CAPABILITY_UNSAFE"],
  ];
  for (const [name, mutate, expectedCode] of cases) {
    await t.test(name, async () => {
      const base = await makeProposalInput();
      const writer = new FakeProposalWriteClient();
      const input = mutate(base, writer);
      const result = await submitTechnicalProfileProposal(input);
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.failureCode, expectedCode);
      assert.deepEqual(writer.calls, []);
      assert.deepEqual((base.readClient as GitHubReadClient & { calls: string[] }).calls, []);
    });
  }
});

test("does not require proposal credentials or create an empty PR for a valid no-op", async () => {
  const input = await makeProposalInput({ noChanges: true });
  const { writeClient: _writer, ...withoutWriter } = input;
  const result = await submitTechnicalProfileProposal(withoutWriter);

  assert.equal(input.reconciliation.status, "NO_CHANGES");
  assert.equal(result.status, "NO_CHANGES");
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(input.writeClient.calls, []);
  assert.deepEqual(input.readClient.calls, []);
});

test("blocks branch collisions and commits containing any other changed path", async () => {
  const collisionInput = await makeProposalInput();
  collisionInput.writeClient.branchResult = { status: "ALREADY_EXISTS", branchName: "", baseCommitSha: SNAPSHOT.commitSha };
  const collision = await submitTechnicalProfileProposal(collisionInput);
  assert.equal(collision.status, "FAILED");
  assert.equal(collision.failureCode, "BRANCH_COLLISION");
  assert.equal(collisionInput.writeClient.calls.some((call) => call.method === "commitSingleProfileFile"), false);

  const boundaryInput = await makeProposalInput();
  boundaryInput.writeClient.changedPaths = [TECHNICAL_PROFILE_PATH, "README.md"];
  const boundary = await submitTechnicalProfileProposal(boundaryInput);
  assert.equal(boundary.status, "FAILED");
  assert.equal(boundary.failureCode, "ARTIFACT_BOUNDARY_VIOLATION");
  assert.equal(boundaryInput.writeClient.calls.some((call) => call.method === "createPullRequest"), false);
});

test("does not open a PR if the default branch changes after commit but before PR creation", async () => {
  const input = await makeProposalInput();
  let headReads = 0;
  const readClient: GitHubReadClient = {
    ...input.readClient,
    getDefaultBranchCommit: async (_configuration, branch) => {
      headReads += 1;
      return {
        ...SNAPSHOT,
        branch,
        commitSha: headReads === 1 ? SNAPSHOT.commitSha : "f".repeat(40),
      };
    },
  };
  const result = await submitTechnicalProfileProposal({ ...input, readClient });

  assert.equal(result.status, "STALE");
  assert.equal(result.failureCode, "STALE_SNAPSHOT");
  assert.equal(input.writeClient.calls.some((call) => call.method === "createFeatureBranch"), true);
  assert.equal(input.writeClient.calls.some((call) => call.method === "commitSingleProfileFile"), true);
  assert.equal(input.writeClient.calls.some((call) => call.method === "createPullRequest"), false);
});

test("closes a PR if the default branch becomes stale during handoff", async () => {
  const input = await makeProposalInput();
  const readClient = input.readClient;
  let branchReads = 0;
  const raceReadClient: GitHubReadClient = {
    ...readClient,
    getDefaultBranchCommit: async (_configuration, branch) => {
      branchReads += 1;
      return {
        ...SNAPSHOT,
        branch,
        commitSha: branchReads <= 2 ? SNAPSHOT.commitSha : "f".repeat(40),
      };
    },
  };
  const result = await submitTechnicalProfileProposal({ ...input, readClient: raceReadClient });

  assert.equal(result.status, "STALE");
  assert.equal(result.failureCode, "STALE_PULL_REQUEST_CLOSED");
  assert.equal(input.writeClient.calls.at(-1)?.method, "closePullRequest");
  assert.equal(input.writeClient.calls.some((call) => call.method === "createPullRequest"), true);
});

async function submitWithPostPullRequestReadFailure(
  input: Awaited<ReturnType<typeof makeProposalInput>>,
): Promise<ProposalResult> {
  let branchReads = 0;
  const readClient: GitHubReadClient = {
    ...input.readClient,
    getDefaultBranchCommit: async (_configuration, branch) => {
      branchReads += 1;
      if (branchReads > 2) throw new GitHubReadError("NETWORK_FAILURE");
      return { ...SNAPSHOT, branch };
    },
  };
  return submitTechnicalProfileProposal({ ...input, readClient });
}

test("closes the new PR once when post-creation freshness cannot be verified", async () => {
  const input = await makeProposalInput();
  const result = await submitWithPostPullRequestReadFailure(input);

  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "POST_PULL_REQUEST_STATE_UNVERIFIED_CLOSED");
  assert.equal(result.pullRequest?.number, 7);
  assertSingleProposalAttempt(input.writeClient);
  assert.equal(input.writeClient.calls.filter((call) => call.method === "closePullRequest").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC|NETWORK_FAILURE/);
});

test("reports an unverified PR as open when safe closure fails", async () => {
  const input = await makeProposalInput();
  input.writeClient.closePullRequest = async (request) => {
    input.writeClient.calls.push({ method: "closePullRequest", input: request });
    throw new Error("SYNTHETIC_ONLY_CLOSE_RESPONSE_VALUE");
  };
  const result = await submitWithPostPullRequestReadFailure(input);

  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "POST_PULL_REQUEST_STATE_UNVERIFIED_OPEN");
  assert.equal(result.pullRequest?.number, 7);
  assertSingleProposalAttempt(input.writeClient);
  assert.equal(input.writeClient.calls.filter((call) => call.method === "closePullRequest").length, 1);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_ONLY_CLOSE_RESPONSE_VALUE/);
});

test("reports an unverified PR as open when safe closure is unavailable", async () => {
  const input = await makeProposalInput();
  Object.assign(input.writeClient, { closePullRequest: undefined });
  const result = await submitWithPostPullRequestReadFailure(input);

  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "POST_PULL_REQUEST_STATE_UNVERIFIED_OPEN");
  assert.equal(result.pullRequest?.number, 7);
  assertSingleProposalAttempt(input.writeClient);
  assert.equal(input.writeClient.calls.some((call) => call.method === "closePullRequest"), false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC/);
});

test("closes an attributable PR response that targets the wrong base branch", async () => {
  const input = await makeProposalInput();
  input.writeClient.pullRequestBaseBranch = "main";
  const result = await submitTechnicalProfileProposal(input);

  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "PULL_REQUEST_RESPONSE_INVALID");
  assert.equal(input.writeClient.calls.some((call) => call.method === "closePullRequest"), true);
});

test("aborts a timed-out proposal write without retrying it", async () => {
  const input = await makeProposalInput();
  input.proposalOperationTimeoutMs = 100;
  let receivedSignal: AbortSignal | undefined;
  input.writeClient.createFeatureBranch = async (request) => {
    input.writeClient.calls.push({ method: "createFeatureBranch", input: request });
    receivedSignal = request.signal;
    return new Promise<ProposalBranchResult>(() => undefined);
  };

  const result = await submitTechnicalProfileProposal(input);

  assert.equal(result.status, "FAILED");
  assert.equal(result.failureCode, "PROPOSAL_TIMED_OUT");
  assert.equal(input.writeClient.calls.filter((call) => call.method === "createFeatureBranch").length, 1);
  assert.equal(input.writeClient.calls.some((call) => call.method === "commitSingleProfileFile"), false);
  assert.equal(receivedSignal?.aborted, true);
});