import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RunConfiguration } from "../src/config.js";
import { coordinateRun } from "../src/coordinator.js";
import { GitHubReadError } from "../src/github-errors.js";
import { AUTOMATED_TEST_SUITE_VERSION, type AutomatedTestBinding, type AutomatedTestResult } from "../src/gate.js";
import type { SecretScanner } from "../src/filter.js";
import type { ProposalWriteCapability, ProposalWriteClient } from "../src/proposal.js";

const FIXED_UUID = "00000000-0000-4000-8000-000000000001";
const FIXED_TIME = new Date("2026-10-07T12:00:00.000Z");
const VALID_CONFIGURATION: RunConfiguration = {
  targetRepository: "Octo-Org/Docs",
  normalizedRepositoryId: "octo-org/docs",
  executionContext: "local",
};
const FAKE_REPOSITORY = {
  repositoryId: 42,
  normalizedRepositoryId: "octo-org/docs",
  fullName: "Octo-Org/Docs",
  isPrivate: false,
  defaultBranch: "trunk",
  readRetryCount: 0,
};
const FAKE_SNAPSHOT = {
  branch: "trunk",
  commitSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  readRetryCount: 0,
};
function passingTestResult(binding: AutomatedTestBinding): AutomatedTestResult {
  return {
    status: "PASS",
    suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
    totalTests: 201,
    passedTests: 201,
    failedTests: 0,
    skippedTests: 0,
    binding,
  };
}

function fakeProposalWriteClient(): ProposalWriteClient {
  const capability: ProposalWriteCapability = {
    provider: "dedicated_github_proposal_app",
    normalizedRepositoryId: VALID_CONFIGURATION.normalizedRepositoryId,
    repositoryId: FAKE_REPOSITORY.repositoryId,
    permissions: {
      contents: "write",
      pullRequests: "write",
      canApprove: false,
      canMerge: false,
      canBypassBranchProtection: false,
      canWriteDefaultBranch: false,
    },
    branchProtection: { pullRequestRequired: true, humanApprovalRequired: true, proposalAppBypass: false },
  };
  return {
    capability,
    createFeatureBranch: async (input) => ({
      status: "CREATED",
      branchName: input.branchName,
      baseCommitSha: input.baseCommitSha,
    }),
    commitSingleProfileFile: async (input) => ({
      commitSha: "c".repeat(40),
      parentCommitSha: input.baseCommitSha,
      treeSha: "d".repeat(40),
      changedPaths: [input.path],
      profileSha256: createHash("sha256").update(input.content.replace(/\r\n/g, "\n"), "utf8").digest("hex"),
    }),
    getBranchHead: async (input) => ({ branchName: input.branchName, commitSha: "c".repeat(40) }),
    createPullRequest: async (input) => ({
      number: 1,
      url: "https://github.com/Octo-Org/Docs/pull/1",
      state: "open",
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
    }),
    closePullRequest: async () => true,
  };
}

function fakeDependencies() {
  return {
    createRunId: () => FIXED_UUID,
    now: () => FIXED_TIME,
    githubClient: {
      getRepositoryMetadata: async () => FAKE_REPOSITORY,
      getDefaultBranchCommit: async () => FAKE_SNAPSHOT,
      getRepositoryTree: async () => ({
        treeSha: FAKE_SNAPSHOT.treeSha,
        entries: [],
        truncated: false,
        readRetryCount: 0,
      }),
      getGitBlob: async () => { throw new Error("Unexpected blob request in coordinator unit test."); },
    },
    secretScanner: {
      id: "test_double",
      executionBoundary: "local",
      version: "test-double/1",
      scan: async (files) => ({ status: "complete", scannedFileCount: files.length, findings: [] }),
    } satisfies SecretScanner,
    automatedTests: (binding: AutomatedTestBinding) => passingTestResult(binding),
    automatedTestTimeoutMs: 100,
    proposalWriteClient: fakeProposalWriteClient(),
  };
}

test("creates a run context from valid configuration", async () => {
  const result = await coordinateRun(VALID_CONFIGURATION, fakeDependencies());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.context.targetRepository, "Octo-Org/Docs");
  assert.equal(result.context.normalizedRepositoryId, "octo-org/docs");
  assert.equal(result.context.executionContext, "local");
  assert.equal(result.context.runId, `run-${FIXED_UUID}`);
  assert.equal(result.context.startedAt, FIXED_TIME.toISOString());
});

test("generates an opaque run identifier and retains the Actions context", async () => {
  const result = await coordinateRun(
    { ...VALID_CONFIGURATION, executionContext: "actions", runId: "12345" },
    fakeDependencies(),
  );

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.match(result.context.runId, /^run-[0-9a-f-]{36}$/i);
  assert.equal(result.context.executionContext, "actions");
  assert.equal(result.context.workflowRunId, "12345");
});

test("moves through collection and filtering using one immutable snapshot", async () => {
  const result = await coordinateRun(VALID_CONFIGURATION, fakeDependencies());

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.context.stage, "PROPOSED");
  assert.equal(result.context.status, "ready");
  assert.equal(result.context.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.equal(result.filtered.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.equal(result.filtered.status, "ready");
  assert.equal(result.filtered.scan.coverageComplete, true);
  assert.deepEqual(result.filtered.existingProfile, { status: "absent" });
  assert.deepEqual(result.analysis.observations, []);
  assert.deepEqual(result.analysis.issues, []);
  assert.equal(result.evidenceCatalog.coverage.length, 16);
  assert.equal(result.evidenceCatalog.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.ok(result.evidenceCatalog.evidence.some((item) => item.sourceType === "github_metadata" && item.fact.name === "Repository"));
  assert.equal(result.composition.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.equal(result.composition.schemaVersion, 1);
  assert.equal(result.composition.candidateSha256.length, 64);
  assert.match(result.composition.candidate, /^# Technical Profile\n/);
  assert.equal(result.reconciliation.status, "FIRST_GENERATION");
  assert.equal(result.validation.status, "PASS");
  assert.equal(result.gate.status, "PASS");
  assert.equal(result.proposalAuthorization.status, "AUTHORIZED");
  assert.equal(result.proposalAuthorization.binding.targetRepository, VALID_CONFIGURATION.normalizedRepositoryId);
  assert.equal(result.proposalAuthorization.binding.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.equal(result.proposalAuthorization.binding.candidateSha256, result.reconciliation.candidateSha256);
  assert.ok(result.validation.checks.length > 0);
  assert.equal(result.reconciliation.candidate, result.composition.candidate);
  assert.equal(result.reconciliation.candidateSha256, result.composition.candidateSha256);
  assert.equal("collection" in result, false);
  assert.equal(result.repository.defaultBranch, "trunk");
  assert.equal(result.diagnostic.defaultBranch, "trunk");
  assert.equal(result.diagnostic.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.equal(result.diagnostic.profilePresent, false);
  assert.equal(result.diagnostic.event, "proposal_created");
  assert.equal(result.diagnostic.fromStage, "GATE_CHECKED");
  assert.equal(result.diagnostic.toStage, "PROPOSED");
  assert.equal(result.diagnostic.validationStatus, "PASS");
  assert.equal(result.diagnostic.gateStatus, "PASS");
  assert.equal(result.diagnostic.automatedTestStatus, "PASS");
  assert.equal(result.proposal.status, "CREATED");
  assert.equal(result.diagnostic.proposalStatus, "CREATED");
  assert.equal(result.diagnostic.pullRequestNumber, 1);
  assert.equal(result.diagnostic.coverageEntryCount, 16);
  assert.equal(result.report.outcome, "PROPOSED");
  assert.equal(result.report.runId, result.context.runId);
  assert.equal(result.report.targetRepository, VALID_CONFIGURATION.normalizedRepositoryId);
  assert.equal(result.report.githubRepositoryId, FAKE_REPOSITORY.repositoryId);
  assert.equal(result.report.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.equal(result.report.candidateSha256, result.reconciliation.candidateSha256);
  assert.deepEqual(result.report.stages.map((stage) => stage.id), [
    "COLLECTION", "FILTERING", "ANALYSIS", "EVIDENCE", "COMPOSITION",
    "RECONCILIATION", "VALIDATION", "GATE", "PROPOSAL",
  ]);
  assert.ok(result.report.stages.every((stage) => stage.status === "PASS"));
  assert.equal(result.report.counts.profileFields, 16);
  assert.equal(result.report.proposal?.pullRequestNumber, 1);
  assert.deepEqual(result.report.proposal?.changedFilePaths, ["technical-profile.md"]);
  assert.doesNotMatch(JSON.stringify(result.report), /candidate contents|package\.json|source text/i);
});

test("returns observations from sanitized snapshot files through coordinator integration", async () => {
  const manifest = Buffer.from(JSON.stringify({ name: "coordinator-fixture", engines: { node: ">=20" } }), "utf8");
  const blobSha = "c".repeat(40);
  const dependencies = fakeDependencies();
  const result = await coordinateRun(VALID_CONFIGURATION, {
    ...dependencies,
    secretScanner: {
      id: "test_double",
      executionBoundary: "local",
      version: "test-double/1",
      scan: async (files) => ({ status: "complete", scannedFileCount: files.length, findings: [] }),
    },
    githubClient: {
      ...dependencies.githubClient,
      getRepositoryTree: async () => ({
        treeSha: FAKE_SNAPSHOT.treeSha,
        entries: [{ path: "package.json", mode: "100644", type: "blob", sha: blobSha, size: manifest.length }],
        truncated: false,
        readRetryCount: 0,
      }),
      getGitBlob: async () => ({
        sha: blobSha,
        size: manifest.length,
        encoding: "base64",
        content: manifest.toString("base64"),
        readRetryCount: 0,
      }),
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.context.stage, "PROPOSED");
  assert.equal(result.analysis.snapshotCommitSha, FAKE_SNAPSHOT.commitSha);
  assert.ok(result.analysis.observations.some((observation) =>
    observation.category === "package_name" && observation.value === "coordinator-fixture"));
  assert.ok(result.analysis.observations.some((observation) =>
    observation.category === "node_engine_constraint" && observation.value === ">=20"));
  assert.ok(result.evidenceCatalog.evidence.some((item) =>
    item.profileField === "Application Name" && item.fact.value === "coordinator-fixture"));
  assert.ok(result.composition.candidate.includes("coordinator-fixture"));
  assert.equal(result.reconciliation.status, "FIRST_GENERATION");
  assert.equal(result.gate.status, "PASS");
});

test("blocks when the default local scanner is unavailable", async () => {
  const dependencies = fakeDependencies();
  const { secretScanner: _testScanner, ...withoutScanner } = dependencies;
  const result = await coordinateRun(VALID_CONFIGURATION, withoutScanner);

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, "SCANNER_UNAVAILABLE");
  assert.equal(result.context?.stage, "FILTERED");
  assert.equal(result.context?.status, "failed");
  assert.equal(result.diagnostic.event, "filter_blocked");
  assert.equal(result.report.outcome, "BLOCKED");
  assert.ok(result.report.errors.some((error) => error.code === "SCANNER_UNAVAILABLE" && error.stage === "FILTERING"));
});

test("keeps synthetic secret values out of coordinator results and diagnostics", async () => {
  const syntheticValue = "SYNTHETIC_ONLY_TOKEN=COORDINATOR_FIXTURE_987";
  const content = Buffer.from(syntheticValue, "utf8");
  const blobSha = "c".repeat(40);
  const scanner: SecretScanner = {
    id: "test_double",
    executionBoundary: "local",
    version: "test-double/1",
    scan: async (files) => ({
      status: "complete",
      scannedFileCount: files.length,
      findings: files.some((file) => /SYNTHETIC_ONLY_TOKEN=/.test(file.content))
        ? [{ path: files[0]?.path ?? "", ruleId: "synthetic_test_rule", severity: "high" }]
        : [],
    }),
  };
  const result = await coordinateRun(VALID_CONFIGURATION, {
    ...fakeDependencies(),
    secretScanner: scanner,
    githubClient: {
      ...fakeDependencies().githubClient,
      getRepositoryTree: async () => ({
        treeSha: FAKE_SNAPSHOT.treeSha,
        entries: [{ path: "src/unsafe.ts", mode: "100644", type: "blob", sha: blobSha, size: content.length }],
        truncated: false,
        readRetryCount: 0,
      }),
      getGitBlob: async () => ({
        sha: blobSha,
        size: content.length,
        encoding: "base64",
        content: content.toString("base64"),
        readRetryCount: 0,
      }),
    },
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.filtered.status, "partial");
  assert.deepEqual(result.filtered.analysisFiles, []);
  assert.doesNotMatch(JSON.stringify(result), /COORDINATOR_FIXTURE_987/);
  assert.equal("collection" in result, false);
});

test("rejects invalid or inconsistent configuration with a typed failure", async () => {
  const result = await coordinateRun({
    ...VALID_CONFIGURATION,
    normalizedRepositoryId: "another/repository",
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }

  assert.equal(result.error.code, "INVALID_CONFIGURATION");
  assert.equal(result.diagnostic.event, "run_initialization_failed");
});

test("does not accept branch configuration", async () => {
  const result = await coordinateRun({ ...VALID_CONFIGURATION, branch: "main" });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_CONFIGURATION");
  }
});

test("returns a typed sanitized failure when GitHub metadata access fails", async () => {
  const result = await coordinateRun(VALID_CONFIGURATION, {
    ...fakeDependencies(),
    githubClient: {
      ...fakeDependencies().githubClient,
      getRepositoryMetadata: async () => {
        throw new GitHubReadError("AUTHENTICATION_FAILED");
      },
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "AUTHENTICATION_FAILED");
    assert.equal(result.context?.stage, "READY_FOR_COLLECTION");
    assert.equal(result.context?.status, "failed");
    assert.equal(result.report.outcome, "FAILED");
    assert.equal(result.report.errors[0]?.message.includes("SYNTHETIC"), false);
  }
});

test("does not make network requests when a fake client is injected", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response();
  };

  try {
    const result = await coordinateRun(VALID_CONFIGURATION, fakeDependencies());
    assert.equal(result.ok, true);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostics omit injected sensitive values and configuration fields", async () => {
  const sensitiveProbe = randomUUID();
  const result = await coordinateRun({ ...VALID_CONFIGURATION, token: sensitiveProbe });
  const serializedResult = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.doesNotMatch(serializedResult, new RegExp(sensitiveProbe));
  assert.doesNotMatch(serializedResult, /targetRepository/);
});

test("CLI rejects branch overrides before contacting GitHub", () => {
  const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cliPath, "--repository", "Octo-Org/Docs", "--branch", "main"],
    { encoding: "utf8", env: { GITHUB_ACTIONS: "false" } },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Branch overrides/);
});

test("blocks gate progression when the automated test result is missing or failed", async (t) => {
  await t.test("missing test result", async () => {
    const { automatedTests: _tests, ...dependencies } = fakeDependencies();
    const result = await coordinateRun(VALID_CONFIGURATION, dependencies);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "GATE_BLOCKED");
    assert.equal(result.context?.stage, "GATE_CHECKED");
    assert.equal(result.gate?.status, "BLOCKED");
    assert.ok(result.gate?.blockingFailures.some((failure) => failure.code === "AUTOMATED_TESTS_UNAVAILABLE"));
    assert.equal(result.report.outcome, "BLOCKED");
    assert.ok(result.report.errors.some((error) => error.code === "AUTOMATED_TESTS_UNAVAILABLE"));
    assert.equal("proposalAuthorization" in result, false);
  });

  await t.test("failed test result", async () => {
    const result = await coordinateRun(VALID_CONFIGURATION, {
      ...fakeDependencies(),
      automatedTests: (binding: AutomatedTestBinding) => ({
        ...passingTestResult(binding),
        status: "FAIL",
        failedTests: 1,
        passedTests: 126,
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "GATE_BLOCKED");
    assert.equal(result.gate?.status, "BLOCKED");
    assert.ok(result.gate?.blockingFailures.some((failure) => failure.code === "AUTOMATED_TESTS_FAILED"));
    assert.equal("proposalAuthorization" in result, false);
  });

  await t.test("timed-out test result", async () => {
    const result = await coordinateRun(VALID_CONFIGURATION, {
      ...fakeDependencies(),
      automatedTests: async () => new Promise<AutomatedTestResult>(() => undefined),
      automatedTestTimeoutMs: 5,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "GATE_BLOCKED");
    assert.ok(result.gate?.blockingFailures.some((failure) => failure.code === "AUTOMATED_TESTS_TIMED_OUT"));
    assert.equal("proposalAuthorization" in result, false);
  });
});

test("blocks proposal creation when the dedicated proposal App adapter is unavailable", async () => {
  const { proposalWriteClient: _proposalClient, ...dependencies } = fakeDependencies();
  const result = await coordinateRun(VALID_CONFIGURATION, dependencies);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PROPOSAL_BLOCKED");
  assert.equal(result.context?.stage, "GATE_CHECKED");
  assert.equal(result.gate?.status, "PASS");
  assert.equal(result.proposal?.status, "BLOCKED");
  assert.equal(result.proposal?.failureCode, "PROPOSAL_CAPABILITY_UNAVAILABLE");
  assert.equal(result.report.outcome, "FAILED");
  assert.equal(result.report.proposal?.status, "BLOCKED");
  assert.equal(result.report.proposal?.pullRequestNumber, undefined);
  assert.ok(result.report.errors.some((error) => error.code === "PROPOSAL_BLOCKED" && error.stage === "PROPOSAL"));
  assert.equal("proposalAuthorization" in result, false);
});

test("fails fast when another proposal-capable run is active for the same repository", async () => {
  let markTestsStarted!: () => void;
  let releaseTests!: () => void;
  const testsStarted = new Promise<void>((resolve) => { markTestsStarted = resolve; });
  const holdTests = new Promise<void>((resolve) => { releaseTests = resolve; });
  const firstRun = coordinateRun(VALID_CONFIGURATION, {
    ...fakeDependencies(),
    automatedTests: async (binding: AutomatedTestBinding) => {
      markTestsStarted();
      await holdTests;
      return passingTestResult(binding);
    },
  });

  await testsStarted;
  const concurrentRun = await coordinateRun(VALID_CONFIGURATION, fakeDependencies());
  assert.equal(concurrentRun.ok, false);
  if (!concurrentRun.ok) {
    assert.equal(concurrentRun.error.code, "BUSY");
    assert.equal(concurrentRun.diagnostic.event, "busy");
  }

  releaseTests();
  const completedRun = await firstRun;
  assert.equal(completedRun.ok, true);
});

test("reports an overall run timeout without authorizing a proposal", async () => {
  const result = await coordinateRun(VALID_CONFIGURATION, {
    ...fakeDependencies(),
    automatedTests: async () => new Promise<AutomatedTestResult>(() => undefined),
    automatedTestTimeoutMs: 10_000,
    operationalLimits: { overallRunTimeoutMs: 100 },
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RUN_TIMEOUT");
  assert.equal(result.diagnostic.event, "run_timeout");
  assert.equal(result.report.outcome, "FAILED");
  assert.ok(result.report.errors.some((error) => error.code === "RUN_TIMEOUT"));
  assert.equal("proposalAuthorization" in result, false);
});