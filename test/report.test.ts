import assert from "node:assert/strict";
import test from "node:test";
import { createSanitizedRunReport, type RunReportSource } from "../src/report.js";
import { AUTOMATED_TEST_SUITE_VERSION, MANDATORY_GATE_VERSION, VALIDATOR_VERSION } from "../src/gate.js";

const RUN_ID = "run-00000000-0000-4000-8000-000000000015";
const TARGET = "sample/report-fixture";
const SNAPSHOT = "a".repeat(40);
const DIGEST = "b".repeat(64);
const STARTED_AT = "2026-10-08T10:00:00.000Z";
const COMPLETED_AT = "2026-10-08T10:00:02.000Z";

function successfulSource(): RunReportSource {
  return {
    ok: true,
    context: {
      runId: RUN_ID,
      normalizedRepositoryId: TARGET,
      executionContext: "actions",
      startedAt: STARTED_AT,
      defaultBranch: "release/next",
      snapshotCommitSha: SNAPSHOT,
      stage: "PROPOSED",
      status: "ready",
    },
    repository: {
      repositoryId: 42,
      normalizedRepositoryId: TARGET,
      fullName: "Sample/Report-Fixture",
      isPrivate: false,
      defaultBranch: "release/next",
      readRetryCount: 0,
    },
    filtered: {
      status: "ready",
      repositoryId: TARGET,
      defaultBranch: "release/next",
      snapshotCommitSha: SNAPSHOT,
      analysisFiles: [],
      exclusionRecords: [],
      fileRecords: [],
      securityFindings: [],
      scan: {
        status: "complete",
        scanner: "test_double",
        expectedFileCount: 2,
        scannedFileCount: 2,
        coverageComplete: true,
      },
      existingProfile: { status: "absent" },
    },
    analysis: { repositoryId: TARGET, defaultBranch: "release/next", snapshotCommitSha: SNAPSHOT, observations: [], issues: [] },
    evidenceCatalog: {
      repositoryId: TARGET,
      defaultBranch: "release/next",
      snapshotCommitSha: SNAPSHOT,
      evidence: [],
      coverage: Array.from({ length: 16 }, (_, index) => ({ sectionId: String(index + 1).padStart(2, "0") })),
      issues: [],
    } as unknown as NonNullable<RunReportSource["evidenceCatalog"]>,
    composition: {
      repositoryId: TARGET,
      defaultBranch: "release/next",
      snapshotCommitSha: SNAPSHOT,
      schemaVersion: 1,
      candidate: "# Technical Profile\n",
      candidateSha256: DIGEST,
      sectionDigests: {},
      warnings: [],
    } as unknown as NonNullable<RunReportSource["composition"]>,
    reconciliation: {
      repositoryId: TARGET,
      defaultBranch: "release/next",
      snapshotCommitSha: SNAPSHOT,
      status: "CHANGED",
      candidate: "# Technical Profile\n",
      candidateSha256: DIGEST,
      schemaVersion: 1,
      additions: [],
      modifications: [],
      removals: [],
      conflicts: [],
      preservedManualContent: false,
      existingProfilePreserved: false,
      issues: [],
    } as NonNullable<RunReportSource["reconciliation"]>,
    validation: {
      status: "PASS",
      repositoryId: TARGET,
      defaultBranch: "release/next",
      snapshotCommitSha: SNAPSHOT,
      candidateSha256: DIGEST,
      schemaVersion: 1,
      checks: Array.from({ length: 15 }, () => ({ id: "TEMPLATE_STRUCTURE", status: "PASS", issues: [] })),
      blockingFailures: [],
      warnings: [],
      diagnostics: [],
      reconciliationStatus: "CHANGED",
    } as unknown as NonNullable<RunReportSource["validation"]>,
    gate: {
      status: "PASS",
      binding: {
        runId: RUN_ID,
        targetRepository: TARGET,
        repositoryId: TARGET,
        githubRepositoryId: 42,
        snapshotCommitSha: SNAPSHOT,
        candidateSha256: DIGEST,
        schemaVersion: 1,
        gateVersion: MANDATORY_GATE_VERSION,
        validatorVersion: VALIDATOR_VERSION,
        testSuiteVersion: AUTOMATED_TEST_SUITE_VERSION,
        scannerId: "test_double",
        scannerVersion: "test-double/1",
      },
      checks: [],
      blockingFailures: [],
      validationResult: {} as NonNullable<RunReportSource["validation"]>,
      automatedTestResult: {
        status: "PASS",
        suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
        totalTests: 213,
        passedTests: 213,
        failedTests: 0,
        skippedTests: 0,
        binding: {
          runId: RUN_ID,
          targetRepository: TARGET,
          snapshotCommitSha: SNAPSHOT,
          candidateSha256: DIGEST,
          schemaVersion: 1,
        },
      },
      securityScanResult: {
        scannerId: "test_double",
        scannerVersion: "test-double/1",
        inputScanStatus: "complete",
        expectedFileCount: 2,
        scannedFileCount: 2,
        coverageComplete: true,
        candidateScanStatus: "PASS",
      },
    } as unknown as NonNullable<RunReportSource["gate"]>,
    proposal: {
      status: "CREATED",
      targetRepository: TARGET,
      snapshotCommitSha: SNAPSHOT,
      candidateSha256: DIGEST,
      allowedArtifactPath: "technical-profile.md",
      changedFiles: ["technical-profile.md"],
      branchName: `docs-sync/technical-profile/${RUN_ID.slice(4)}-${DIGEST.slice(0, 12)}`,
      commitSha: "c".repeat(40),
      pullRequest: {
        number: 12,
        url: "https://github.com/sample/report-fixture/pull/12",
      },
    },
  };
}

test("constructs a deterministic sanitized report with all pipeline stages and binding fields", () => {
  const source = successfulSource();
  const first = createSanitizedRunReport(source, COMPLETED_AT);
  const second = createSanitizedRunReport(source, COMPLETED_AT);

  assert.deepEqual(first, second);
  assert.equal(first.outcome, "PROPOSED");
  assert.equal(first.runId, RUN_ID);
  assert.equal(first.targetRepository, TARGET);
  assert.equal(first.githubRepositoryId, 42);
  assert.equal(first.snapshotCommitSha, SNAPSHOT);
  assert.equal(first.candidateSha256, DIGEST);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.startedAt, STARTED_AT);
  assert.equal(first.completedAt, COMPLETED_AT);
  assert.deepEqual(first.stages.map((stage) => stage.id), [
    "COLLECTION", "FILTERING", "ANALYSIS", "EVIDENCE", "COMPOSITION",
    "RECONCILIATION", "VALIDATION", "GATE", "PROPOSAL",
  ]);
  assert.equal(first.stages.every((stage) => stage.status === "PASS"), true);
});

test("reports no-op without claiming a PR and reports a proposal failure as FAILED", () => {
  const noOp = createSanitizedRunReport({
    ...successfulSource(),
    proposal: {
      status: "NO_CHANGES",
      targetRepository: TARGET,
      snapshotCommitSha: SNAPSHOT,
      candidateSha256: DIGEST,
      allowedArtifactPath: "technical-profile.md",
      changedFiles: [],
    },
  }, COMPLETED_AT);
  assert.equal(noOp.outcome, "NO_CHANGES");
  assert.equal(noOp.proposal?.status, "NO_CHANGES");
  assert.equal(noOp.proposal?.pullRequestNumber, undefined);
  assert.equal(noOp.proposal?.changedFileCount, 0);

  const failed = createSanitizedRunReport({
    ok: false,
    context: { runId: RUN_ID, normalizedRepositoryId: TARGET, stage: "GATE_CHECKED", status: "failed" },
    error: { code: "PROPOSAL_FAILED" },
    proposal: {
      status: "FAILED",
      targetRepository: TARGET,
      snapshotCommitSha: SNAPSHOT,
      candidateSha256: DIGEST,
      allowedArtifactPath: "technical-profile.md",
      changedFiles: [],
      failureCode: "COMMIT_FAILED",
    },
  }, COMPLETED_AT);
  assert.equal(failed.outcome, "FAILED");
  assert.equal(failed.proposal?.status, "FAILED");
  assert.ok(failed.errors.some((error) => error.code === "PROPOSAL_FAILED" && error.stage === "PROPOSAL"));
});

test("reports gate-blocked and stale outcomes with sanitized failure codes", () => {
  const successful = successfulSource();
  const blocked = createSanitizedRunReport({
    ...successful,
    ok: false,
    context: { runId: RUN_ID, normalizedRepositoryId: TARGET, stage: "GATE_CHECKED", status: "failed" },
    error: { code: "GATE_BLOCKED" },
    gate: {
      ...successful.gate as NonNullable<RunReportSource["gate"]>,
      status: "BLOCKED",
      blockingFailures: [{ checkId: "AUTOMATED_TESTS", code: "AUTOMATED_TESTS_FAILED" }],
    },
  });
  assert.equal(blocked.outcome, "BLOCKED");
  assert.ok(blocked.errors.some((error) => error.code === "GATE_BLOCKED"));

  const stale = createSanitizedRunReport({
    ok: false,
    context: { runId: RUN_ID, normalizedRepositoryId: TARGET, stage: "GATE_CHECKED", status: "failed" },
    error: { code: "PROPOSAL_STALE" },
    proposal: {
      status: "STALE",
      targetRepository: TARGET,
      snapshotCommitSha: SNAPSHOT,
      candidateSha256: DIGEST,
      allowedArtifactPath: "technical-profile.md",
      changedFiles: ["technical-profile.md"],
      failureCode: "STALE_SNAPSHOT",
    },
  });
  assert.equal(stale.outcome, "BLOCKED");
  assert.equal(stale.staleSnapshot, true);
  assert.equal(stale.proposal?.staleSnapshot, true);
  assert.deepEqual(stale.proposal?.changedFilePaths, ["technical-profile.md"]);
});

test("reports collection, scanner, validation, gate, and proposal failures at their actual stages", () => {
  const cases: Array<[string, RunReportSource, string, string]> = [
    ["collection failure", {
      ok: false,
      context: { runId: RUN_ID, normalizedRepositoryId: TARGET, stage: "READY_FOR_COLLECTION", status: "failed" },
      error: { code: "TREE_RETRIEVAL_FAILED" },
    }, "FAILED", "COLLECTION"],
    ["scanner unavailable", {
      ok: false,
      context: { runId: RUN_ID, normalizedRepositoryId: TARGET, stage: "FILTERED", status: "failed" },
      error: { code: "SCANNER_UNAVAILABLE" },
    }, "BLOCKED", "FILTERING"],
    ["validation failure", {
      ...successfulSource(),
      ok: false,
      error: { code: "VALIDATION_FAILED" },
      validation: {
        ...successfulSource().validation as NonNullable<RunReportSource["validation"]>,
        status: "FAIL",
        blockingFailures: [{ code: "SECTION_MISSING", sectionId: "06" }],
      } as unknown as NonNullable<RunReportSource["validation"]>,
    }, "BLOCKED", "VALIDATION"],
    ["gate failure", {
      ...successfulSource(),
      ok: false,
      error: { code: "GATE_BLOCKED" },
      gate: {
        ...successfulSource().gate as NonNullable<RunReportSource["gate"]>,
        status: "BLOCKED",
        blockingFailures: [{ checkId: "AUTOMATED_TESTS", code: "AUTOMATED_TESTS_FAILED" }],
      } as NonNullable<RunReportSource["gate"]>,
    }, "BLOCKED", "GATE"],
    ["proposal failure", {
      ...successfulSource(),
      ok: false,
      error: { code: "PROPOSAL_FAILED" },
      proposal: {
        status: "FAILED",
        targetRepository: TARGET,
        snapshotCommitSha: SNAPSHOT,
        candidateSha256: DIGEST,
        allowedArtifactPath: "technical-profile.md",
        changedFiles: [],
        failureCode: "COMMIT_FAILED",
      },
    }, "FAILED", "PROPOSAL"],
  ];

  for (const [name, source, outcome, stage] of cases) {
    const report = createSanitizedRunReport(source);
    assert.equal(report.outcome, outcome, name);
    assert.ok(report.errors.some((error) => error.stage === stage), name);
  }
});

test("maps arbitrary error messages to fixed text and never copies raw source or scanner values", () => {
  const syntheticValue = "SYNTHETIC_ONLY_TOKEN=REPORT_TEST_VALUE_892";
  const source = {
    ok: false,
    context: { runId: RUN_ID, normalizedRepositoryId: TARGET, stage: "READY_FOR_COLLECTION", status: "failed" },
    error: { code: "NETWORK_FAILURE", message: syntheticValue, body: syntheticValue },
    rawSourceContents: syntheticValue,
    rawScannerOutput: syntheticValue,
    authorizationHeader: `Bearer ${syntheticValue}`,
  } as unknown as RunReportSource;
  const report = createSanitizedRunReport(source);
  const serialized = JSON.stringify(report);

  assert.equal(report.outcome, "FAILED");
  assert.equal(report.errors[0]?.message, "A repository request failed.");
  assert.doesNotMatch(serialized, /REPORT_TEST_VALUE_892|authorizationHeader|rawSourceContents|rawScannerOutput/);
  assert.deepEqual(Object.keys(report).sort(), [
    "counts", "errors", "outcome", "reportVersion", "runId", "stages", "staleSnapshot", "targetRepository",
  ].sort());
});

test("rejects unauthorized changed paths and malformed PR URLs in report output", () => {
  const source = {
    ...successfulSource(),
    proposal: {
      status: "CREATED",
      targetRepository: TARGET,
      snapshotCommitSha: SNAPSHOT,
      candidateSha256: DIGEST,
      allowedArtifactPath: "technical-profile.md",
      changedFiles: ["technical-profile.md", "README.md"],
      branchName: "docs-sync/technical-profile/unsafe-value",
      pullRequest: { number: 1, url: "https://user:password@github.com/other/repo/pull/1" },
    },
  } as unknown as RunReportSource;
  const report = createSanitizedRunReport(source);

  assert.equal(report.outcome, "FAILED");
  assert.deepEqual(report.proposal?.changedFilePaths, []);
  assert.equal(report.proposal?.pullRequestUrl, undefined);
  assert.ok(report.errors.some((error) => error.code === "ARTIFACT_BOUNDARY_VIOLATION"));
  assert.doesNotMatch(JSON.stringify(report), /user:password|README\.md|unsafe-value/);
});

test("returns a minimal sanitized failure report for malformed input", () => {
  const malformed = {
    ok: false,
    context: { runId: RUN_ID, normalizedRepositoryId: TARGET },
    filtered: { fileRecords: null },
    error: { code: "RUN_FAILED", message: "SYNTHETIC_ONLY_TOKEN=REPORT_MALFORMED_VALUE" },
  } as unknown as RunReportSource;
  const report = createSanitizedRunReport(malformed);

  assert.equal(report.outcome, "FAILED");
  assert.equal(report.errors[0]?.code, "REPORT_UNSAFE");
  assert.deepEqual(report.counts, {
    filesDiscovered: 0,
    filesEligible: 0,
    filesExcluded: 0,
    filesRejectedForSecurity: 0,
    observations: 0,
    evidenceItems: 0,
    profileFields: 0,
    reconciliationChanges: 0,
    validationChecks: 0,
    gateChecks: 0,
    proposalChangedFiles: 0,
  });
  assert.doesNotMatch(JSON.stringify(report), /REPORT_MALFORMED_VALUE/);
});