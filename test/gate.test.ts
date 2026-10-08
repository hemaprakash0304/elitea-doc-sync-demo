import assert from "node:assert/strict";
import test from "node:test";
import { composeTechnicalProfile } from "../src/composer.js";
import { TECHNICAL_PROFILE_PATH, type CollectedFile, type ExistingProfileInput } from "../src/collection.js";
import type { RunConfiguration } from "../src/config.js";
import {
  AUTOMATED_TEST_SUITE_VERSION,
  createAutomatedTestBinding,
  evaluateMandatoryGate,
  isGatePassBoundTo,
  type AutomatedTestResult,
  type MandatoryGateInput,
} from "../src/gate.js";
import type { TechnologyAnalysisResult, TechnicalObservation } from "../src/analyzers/types.js";
import { buildEvidenceCatalog } from "../src/evidence/catalog.js";
import type { RepositoryFilterResult, SecretScanInputFile, SecretScanOutcome, SecretScanner } from "../src/filter.js";
import { reconcileTechnicalProfile } from "../src/reconciler.js";
import { validateReconciledCandidate, type ValidationCheckId, type ValidationIssue } from "../src/validation.js";

const CONFIGURATION: RunConfiguration = {
  targetRepository: "Sample/Gate-Fixture",
  normalizedRepositoryId: "sample/gate-fixture",
  executionContext: "local",
};
const REPOSITORY = {
  repositoryId: 73,
  normalizedRepositoryId: "sample/gate-fixture",
  fullName: "Sample/Gate-Fixture",
  isPrivate: false,
  defaultBranch: "release/next",
  readRetryCount: 0,
};
const SNAPSHOT_SHA = "a".repeat(40);
const RUN_ID = "run-00000000-0000-4000-8000-000000000013";
const TESTS: AutomatedTestResult = {
  status: "PASS",
  suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
  totalTests: 195,
  passedTests: 195,
  failedTests: 0,
  skippedTests: 0,
};

class PassingScanner implements SecretScanner {
  readonly id = "test_double" as const;
  readonly executionBoundary = "local" as const;
  readonly version = "test-double/1";

  async scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    return { status: "complete", scannedFileCount: files.length, findings: [] };
  }
}

function filtered(profilePresent = false): RepositoryFilterResult {
  return {
    status: "ready",
    repositoryId: CONFIGURATION.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    analysisFiles: [],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: {
      status: "complete",
      scanner: "test_double",
      expectedFileCount: profilePresent ? 1 : 0,
      scannedFileCount: profilePresent ? 1 : 0,
      coverageComplete: true,
    },
    existingProfile: profilePresent ? { status: "safe_to_parse" } : { status: "absent" },
  };
}

function dependencyObservation(): TechnicalObservation {
  return {
    analyzer: "javascript_node",
    category: "dependency",
    name: "zod",
    value: "^3.0.0",
    attributes: { scope: "dependencies", versionKind: "declared_specifier" },
    source: { path: "package.json", locator: "package.json:dependencies.zod", kind: "manifest" },
    claimType: "declaration",
    status: "Verified",
    verificationBasis: "manifest_declaration",
    confidence: "High",
  };
}

function makeAnalysis(observations: TechnicalObservation[] = []): TechnologyAnalysisResult {
  return {
    repositoryId: CONFIGURATION.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    observations,
    issues: [],
  };
}

function profileFile(content: string): ExistingProfileInput {
  const bytes = Buffer.from(content, "utf8");
  const file: CollectedFile = {
    path: TECHNICAL_PROFILE_PATH,
    extension: ".md",
    mode: "100644",
    kind: "regular",
    size: bytes.length,
    blobSha: "b".repeat(40),
    sourceCommitSha: SNAPSHOT_SHA,
    contentStatus: "text",
    content,
  };
  return { profilePresent: true, file };
}

function failValidation(
  input: MandatoryGateInput,
  checkId: ValidationCheckId,
  issue: ValidationIssue,
): MandatoryGateInput {
  const checks = input.validation.checks.map((check) => check.id === checkId
    ? { ...check, status: "FAIL" as const, issues: [issue] }
    : check);
  return {
    ...input,
    validation: {
      ...input.validation,
      status: "FAIL",
      checks,
      blockingFailures: [issue],
      diagnostics: [issue],
    },
  };
}

async function createGateInput(
  profileMode: "absent" | "unchanged" | "changed" = "absent",
): Promise<MandatoryGateInput> {
  const filteredInput = filtered(profileMode !== "absent");
  const observations = profileMode === "absent" ? [] : [dependencyObservation()];
  const catalog = buildEvidenceCatalog(filteredInput, makeAnalysis(observations), {
    repositoryFullName: REPOSITORY.fullName,
  });
  const composition = composeTechnicalProfile(catalog);
  let existingProfile: ExistingProfileInput = { profilePresent: false };

  if (profileMode === "unchanged") {
    existingProfile = profileFile(composition.candidate);
  } else if (profileMode === "changed") {
    const oldCatalog = buildEvidenceCatalog(filteredInput, makeAnalysis(), { repositoryFullName: REPOSITORY.fullName });
    existingProfile = profileFile(composeTechnicalProfile(oldCatalog).candidate);
  }

  const reconciliation = reconcileTechnicalProfile(filteredInput, existingProfile, catalog, composition);
  assert.ok(reconciliation.candidate);
  const validation = await validateReconciledCandidate({
    filtered: filteredInput,
    catalog,
    composition,
    reconciliation,
    scanner: new PassingScanner(),
  });
  assert.equal(validation.status, "PASS");

  return {
    runId: RUN_ID,
    configuration: CONFIGURATION,
    repository: REPOSITORY,
    filtered: filteredInput,
    catalog,
    composition,
    reconciliation,
    validation,
    automatedTests: {
      ...TESTS,
      binding: createAutomatedTestBinding({
        runId: RUN_ID,
        configuration: CONFIGURATION,
        filtered: filteredInput,
        composition,
        reconciliation,
      }),
    },
    scannerVersion: "test-double/1",
    changedFilePaths: reconciliation.status === "NO_CHANGES" ? [] : [TECHNICAL_PROFILE_PATH],
  };
}

function assertBlocked(input: MandatoryGateInput, expected: string): void {
  const result = evaluateMandatoryGate(input);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockingFailures.some((failure) => failure.code === expected), expected);
  assert.equal("proposalAuthorization" in result, false);
  assert.equal("candidate" in result, false);
}

test("passes valid first-generation, existing no-op, and changed profile gate inputs", async (t) => {
  const firstGeneration = await createGateInput();
  const firstResult = evaluateMandatoryGate(firstGeneration);
  assert.equal(firstResult.status, "PASS");
  assert.equal(firstResult.proposalAuthorization?.status, "AUTHORIZED");
  assert.equal(firstResult.proposalAuthorization?.allowedArtifactPath, TECHNICAL_PROFILE_PATH);
  assert.equal(firstResult.binding.repositoryId, CONFIGURATION.normalizedRepositoryId);
  assert.equal(firstResult.binding.snapshotCommitSha, SNAPSHOT_SHA);
  assert.equal(firstResult.binding.candidateSha256, firstGeneration.reconciliation.candidateSha256);
  assert.equal(firstResult.binding.schemaVersion, 1);
  assert.equal(firstResult.binding.validatorVersion, "IMP-11/1");
  assert.equal(firstResult.binding.testSuiteVersion, TESTS.suiteVersion);
  assert.deepEqual(firstResult.checks.map((check) => check.status), Array(9).fill("PASS"));

  await t.test("existing unchanged profile", async () => {
    const input = await createGateInput("unchanged");
    assert.equal(input.reconciliation.status, "NO_CHANGES");
    assert.equal(evaluateMandatoryGate(input).status, "PASS");
  });

  await t.test("existing profile with changed evidence", async () => {
    const input = await createGateInput("changed");
    assert.equal(input.reconciliation.status, "CHANGED");
    assert.equal(evaluateMandatoryGate(input).status, "PASS");
  });
});

test("blocks all incomplete, failed, unsafe, or indeterminate gate inputs", async (t) => {
  const base = await createGateInput();
  const malformedReconciliation = { ...base.reconciliation, status: "BLOCKED" as const };
  delete malformedReconciliation.candidate;
  const noScannerVersion = { ...base };
  delete noScannerVersion.scannerVersion;
  const noTestResult = { ...base };
  delete noTestResult.automatedTests;
  const cases: Array<[string, MandatoryGateInput, string]> = [
    ["validator failure", { ...base, validation: { ...base.validation, status: "FAIL" } }, "VALIDATION_NOT_PASSED"],
    ["required validation check missing", {
      ...base,
      validation: { ...base.validation, checks: base.validation.checks.slice(1) },
    }, "VALIDATION_CHECK_MISSING"],
    ["required validation check skipped", {
      ...base,
      validation: {
        ...base.validation,
        checks: base.validation.checks.map((check) => check.id === "SECURITY_SCAN"
          ? { ...check, status: "NOT_RUN" as const }
          : check),
      },
    }, "VALIDATION_CHECK_FAILED"],
    ["target binding mismatch", { ...base, configuration: { ...base.configuration, normalizedRepositoryId: "other/repo" } }, "TARGET_BINDING_MISMATCH"],
    ["snapshot mismatch", { ...base, catalog: { ...base.catalog, snapshotCommitSha: "c".repeat(40) } }, "SNAPSHOT_BINDING_MISMATCH"],
    ["candidate digest mismatch", {
      ...base,
      reconciliation: { ...base.reconciliation, candidateSha256: "0".repeat(64) },
    }, "CANDIDATE_BINDING_MISMATCH"],
    ["unsupported schema", {
      ...base,
      composition: { ...base.composition, schemaVersion: 2 as unknown as 1 },
      reconciliation: { ...base.reconciliation, schemaVersion: 2 },
      validation: { ...base.validation, schemaVersion: 2 },
    }, "SCHEMA_UNSUPPORTED"],
    ["unsafe existing profile", {
      ...base,
      filtered: { ...base.filtered, existingProfile: { status: "blocked_unavailable" } },
    }, "RECONCILIATION_UNSAFE"],
    ["malformed reconciliation", {
      ...base,
      reconciliation: malformedReconciliation,
    }, "RECONCILIATION_UNSAFE"],
    ["missing section", failValidation(base, "TEMPLATE_STRUCTURE", { code: "SECTION_MISSING", sectionId: "06" }), "VALIDATION_CHECK_FAILED"],
    ["evidence integrity failure", failValidation(base, "EVIDENCE_INTEGRITY", { code: "EVIDENCE_ID_UNKNOWN", sectionId: "05" }), "EVIDENCE_OR_COVERAGE_INVALID"],
    ["missing coverage", {
      ...failValidation(base, "COVERAGE_COMPLETENESS", { code: "COVERAGE_ENTRY_MISSING", sectionId: "05" }),
      catalog: { ...base.catalog, coverage: base.catalog.coverage.slice(1) },
    }, "EVIDENCE_OR_COVERAGE_INVALID"],
    ["status semantics failure", failValidation(base, "STATUS_SEMANTICS", { code: "STATUS_INVALID", sectionId: "05" }), "VALIDATION_CHECK_FAILED"],
    ["failure preservation violation", failValidation(base, "FAILURE_PRESERVATION", { code: "PROFILE_PRESERVATION_INVALID" }), "PROFILE_PRESERVATION_INVALID"],
    ["unexpected changed file", { ...base, changedFilePaths: ["README.md"] }, "ARTIFACT_BOUNDARY_VIOLATION"],
    ["scanner unavailable", {
      ...base,
      filtered: { ...base.filtered, scan: { ...base.filtered.scan, scanner: "unavailable" } },
    }, "SECURITY_SCAN_UNAVAILABLE"],
    ["scanner failed", {
      ...base,
      filtered: { ...base.filtered, scan: { ...base.filtered.scan, status: "failed" } },
    }, "SECURITY_SCAN_FAILED"],
    ["incomplete scan", {
      ...base,
      filtered: { ...base.filtered, scan: { ...base.filtered.scan, status: "incomplete", coverageComplete: false } },
    }, "SECURITY_SCAN_INCOMPLETE"],
    ["scanner version unavailable", noScannerVersion, "SCANNER_VERSION_MISSING"],
    ["automated suite missing", noTestResult, "AUTOMATED_TESTS_UNAVAILABLE"],
    ["automated suite failure", { ...base, automatedTests: { ...TESTS, status: "FAIL" } }, "AUTOMATED_TESTS_FAILED"],
    ["automated suite version mismatch", { ...base, automatedTests: { ...TESTS, suiteVersion: "IMP-12/1" } }, "AUTOMATED_TESTS_INDETERMINATE"],
    ["automated suite incomplete", { ...base, automatedTests: { ...TESTS, totalTests: 163, passedTests: 163 } }, "AUTOMATED_TESTS_INDETERMINATE"],
    ["automated suite indeterminate", { ...base, automatedTests: { status: "INDETERMINATE" } }, "AUTOMATED_TESTS_INDETERMINATE"],
    ["automated test attestation bound to a different snapshot", {
      ...base,
      automatedTests: {
        ...base.automatedTests as AutomatedTestResult,
        binding: {
          ...(base.automatedTests as AutomatedTestResult).binding as NonNullable<AutomatedTestResult["binding"]>,
          snapshotCommitSha: "f".repeat(40),
        },
      },
    }, "AUTOMATED_TESTS_INDETERMINATE"],
    ["test report with skipped cases", {
      ...base,
      automatedTests: { ...base.automatedTests as AutomatedTestResult, skippedTests: 1 },
    }, "AUTOMATED_TESTS_INDETERMINATE"],
    ["automated suite skipped", { ...base, automatedTests: { ...TESTS, status: "SKIPPED" } }, "AUTOMATED_TESTS_SKIPPED"],
    ["automated suite cancelled", { ...base, automatedTests: { ...TESTS, status: "CANCELLED" } }, "AUTOMATED_TESTS_CANCELLED"],
    ["automated suite timed out", { ...base, automatedTests: { ...TESTS, status: "TIMEOUT" } }, "AUTOMATED_TESTS_TIMED_OUT"],
  ];

  for (const [name, input, expectedCode] of cases) {
    await t.test(name, () => assertBlocked(input, expectedCode));
  }
});

test("a PASS binding cannot authorize a different snapshot or candidate digest", async () => {
  const input = await createGateInput();
  const result = evaluateMandatoryGate(input);
  assert.equal(result.status, "PASS");
  assert.ok(result.proposalAuthorization);
  assert.equal(isGatePassBoundTo(result, result.binding), true);
  assert.equal(isGatePassBoundTo(result, { ...result.binding, snapshotCommitSha: "b".repeat(40) }), false);
  assert.equal(isGatePassBoundTo(result, { ...result.binding, candidateSha256: "c".repeat(64) }), false);
  assert.equal(isGatePassBoundTo(result, { ...result.binding, targetRepository: "other/repo" }), false);
});