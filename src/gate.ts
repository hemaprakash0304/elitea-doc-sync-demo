import { createHash } from "node:crypto";
import { normalizeRepositoryIdentifier, type RunConfiguration } from "./config.js";
import { TECHNICAL_PROFILE_PATH } from "./collection.js";
import type { GitHubRepositoryMetadata } from "./github-client.js";
import type { EvidenceCatalogResult } from "./evidence/types.js";
import type { ProfileCompositionResult } from "./composer.js";
import type { RepositoryFilterResult } from "./filter.js";
import type { ProfileReconciliationResult } from "./reconciler.js";
import type { ValidationCheckId, ValidationResult } from "./validation.js";

export const MANDATORY_GATE_VERSION = "IMP-13/1";
export const VALIDATOR_VERSION = "IMP-11/1";
export const AUTOMATED_TEST_SUITE_VERSION = "IMP-17/1";
export const REQUIRED_AUTOMATED_TEST_COUNT = 203;

export type MandatoryGateStatus = "PASS" | "BLOCKED";
export type AutomatedTestStatus =
  | "PASS"
  | "FAIL"
  | "UNAVAILABLE"
  | "INDETERMINATE"
  | "TIMEOUT"
  | "CANCELLED"
  | "SKIPPED";

export interface AutomatedTestBinding {
  runId: string;
  targetRepository: string;
  snapshotCommitSha: string;
  candidateSha256: string;
  schemaVersion: number;
}

export interface AutomatedTestResult {
  status: AutomatedTestStatus;
  binding?: AutomatedTestBinding;
  suiteVersion?: string;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
}

export type GateCheckId =
  | "TARGET_BINDING"
  | "SNAPSHOT_BINDING"
  | "CANDIDATE_BINDING"
  | "PROFILE_VALIDATION"
  | "EVIDENCE_COMPLETENESS"
  | "RECONCILIATION_SAFETY"
  | "SECURITY"
  | "ARTIFACT_BOUNDARY"
  | "AUTOMATED_TESTS";

export type GateFailureCode =
  | "TARGET_BINDING_MISMATCH"
  | "SNAPSHOT_BINDING_MISMATCH"
  | "CANDIDATE_BINDING_MISMATCH"
  | "SCHEMA_UNSUPPORTED"
  | "VALIDATION_NOT_PASSED"
  | "VALIDATION_CHECK_MISSING"
  | "VALIDATION_CHECK_FAILED"
  | "EVIDENCE_OR_COVERAGE_INVALID"
  | "RECONCILIATION_UNSAFE"
  | "PROFILE_PRESERVATION_INVALID"
  | "SECURITY_SCAN_UNAVAILABLE"
  | "SECURITY_SCAN_FAILED"
  | "SECURITY_SCAN_INCOMPLETE"
  | "SCANNER_VERSION_MISSING"
  | "ARTIFACT_BOUNDARY_VIOLATION"
  | "AUTOMATED_TESTS_UNAVAILABLE"
  | "AUTOMATED_TESTS_FAILED"
  | "AUTOMATED_TESTS_INDETERMINATE"
  | "AUTOMATED_TESTS_SKIPPED"
  | "AUTOMATED_TESTS_CANCELLED"
  | "AUTOMATED_TESTS_TIMED_OUT";

export interface GateCheckResult {
  id: GateCheckId;
  status: "PASS" | "BLOCKED";
  failureCodes: GateFailureCode[];
}

export interface GateBinding {
  runId: string;
  targetRepository: string;
  repositoryId: string;
  githubRepositoryId: number;
  snapshotCommitSha: string;
  candidateSha256: string;
  schemaVersion: number;
  gateVersion: string;
  validatorVersion: string;
  testSuiteVersion: string;
  scannerId: RepositoryFilterResult["scan"]["scanner"];
  scannerVersion: string;
}

export interface ProposalAuthorization {
  status: "AUTHORIZED";
  binding: GateBinding;
  allowedArtifactPath: typeof TECHNICAL_PROFILE_PATH;
}

export interface MandatoryGateInput {
  runId: string;
  configuration: RunConfiguration;
  repository: GitHubRepositoryMetadata;
  filtered: RepositoryFilterResult;
  catalog: EvidenceCatalogResult;
  composition: ProfileCompositionResult;
  reconciliation: ProfileReconciliationResult;
  validation: ValidationResult;
  automatedTests?: AutomatedTestResult;
  scannerVersion?: string;
  changedFilePaths: readonly string[];
}

export interface MandatoryGateResult {
  status: MandatoryGateStatus;
  binding: GateBinding;
  checks: GateCheckResult[];
  blockingFailures: Array<{ checkId: GateCheckId; code: GateFailureCode }>;
  validationResult: ValidationResult;
  automatedTestResult: {
    status: AutomatedTestStatus | "MISSING";
    binding?: AutomatedTestBinding;
    suiteVersion?: string;
    totalTests?: number;
    passedTests?: number;
    failedTests?: number;
    skippedTests?: number;
  };
  securityScanResult: {
    scannerId: RepositoryFilterResult["scan"]["scanner"];
    scannerVersion?: string;
    inputScanStatus: RepositoryFilterResult["scan"]["status"];
    expectedFileCount: number;
    scannedFileCount: number;
    coverageComplete: boolean;
    candidateScanStatus: "PASS" | "BLOCKED" | "NOT_RUN";
  };
  proposalAuthorization?: ProposalAuthorization;
}

export function createAutomatedTestBinding(
  input: Pick<MandatoryGateInput, "runId" | "configuration" | "filtered" | "composition" | "reconciliation">,
): AutomatedTestBinding {
  const candidate = input.reconciliation.candidate;
  return {
    runId: input.runId,
    targetRepository: input.configuration.normalizedRepositoryId.toLowerCase(),
    snapshotCommitSha: input.filtered.snapshotCommitSha.toLowerCase(),
    candidateSha256: candidate === undefined ? "" : sha256(candidate),
    schemaVersion: input.composition.schemaVersion,
  };
}

const REQUIRED_VALIDATION_CHECKS: readonly ValidationCheckId[] = [
  "FILTERED_INPUT_SAFE",
  "RECONCILIATION_COMPLETE",
  "SNAPSHOT_BINDING",
  "CANDIDATE_DIGEST",
  "TEMPLATE_STRUCTURE",
  "OWNERSHIP_BLOCKS",
  "REQUIRED_FIELDS",
  "EVIDENCE_INTEGRITY",
  "COVERAGE_COMPLETENESS",
  "STATUS_SEMANTICS",
  "SECURITY_SCAN",
  "SENSITIVE_CONTENT",
  "DETERMINISTIC_OUTPUT",
  "CHANGED_FILE_BOUNDARY",
  "FAILURE_PRESERVATION",
];

const PROFILE_CHECKS: readonly ValidationCheckId[] = [
  "TEMPLATE_STRUCTURE", "OWNERSHIP_BLOCKS", "REQUIRED_FIELDS",
];
const EVIDENCE_CHECKS: readonly ValidationCheckId[] = [
  "EVIDENCE_INTEGRITY", "COVERAGE_COMPLETENESS", "STATUS_SEMANTICS",
];
const SECURITY_CHECKS: readonly ValidationCheckId[] = [
  "FILTERED_INPUT_SAFE", "SECURITY_SCAN", "SENSITIVE_CONTENT",
];
export function evaluateMandatoryGate(input: MandatoryGateInput): MandatoryGateResult {
  const candidate = input.reconciliation.candidate;
  const candidateSha256 = candidate === undefined ? "" : sha256(candidate);
  const scannerVersion = safeVersion(input.scannerVersion) ?? "";
  const testSuiteVersion = safeVersion(input.automatedTests?.suiteVersion) ?? "";
  const automatedTestBinding = createAutomatedTestBinding(input);
  const binding: GateBinding = {
    runId: input.runId,
    targetRepository: input.configuration.normalizedRepositoryId.toLowerCase(),
    repositoryId: input.repository.normalizedRepositoryId.toLowerCase(),
    githubRepositoryId: input.repository.repositoryId,
    snapshotCommitSha: input.filtered.snapshotCommitSha.toLowerCase(),
    candidateSha256,
    schemaVersion: input.composition.schemaVersion,
    gateVersion: MANDATORY_GATE_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    testSuiteVersion,
    scannerId: input.filtered.scan.scanner,
    scannerVersion,
  };

  const targetFailures: GateFailureCode[] = [];
  let normalizedTarget: string | undefined;
  try {
    normalizedTarget = normalizeRepositoryIdentifier(input.configuration.targetRepository);
  } catch {
    normalizedTarget = undefined;
  }
  if (
    normalizedTarget === undefined || normalizedTarget !== input.configuration.normalizedRepositoryId.toLowerCase() ||
    !Number.isSafeInteger(input.repository.repositoryId) || input.repository.repositoryId <= 0 ||
    normalizedTarget !== input.repository.normalizedRepositoryId.toLowerCase() ||
    normalizedTarget !== input.repository.fullName.toLowerCase() ||
    normalizedTarget !== input.filtered.repositoryId.toLowerCase() ||
    normalizedTarget !== input.catalog.repositoryId.toLowerCase() ||
    normalizedTarget !== input.composition.repositoryId.toLowerCase() ||
    normalizedTarget !== input.reconciliation.repositoryId.toLowerCase() ||
    normalizedTarget !== input.validation.repositoryId.toLowerCase()
  ) {
    targetFailures.push("TARGET_BINDING_MISMATCH");
  }

  const snapshot = input.filtered.snapshotCommitSha.toLowerCase();
  const snapshotFailures: GateFailureCode[] = [];
  if (
    !/^[0-9a-f]{40}$/.test(snapshot) ||
    [input.catalog, input.composition, input.reconciliation, input.validation]
      .some((source) => source.snapshotCommitSha.toLowerCase() !== snapshot) ||
    input.repository.defaultBranch !== input.filtered.defaultBranch ||
    input.catalog.defaultBranch !== input.filtered.defaultBranch ||
    input.composition.defaultBranch !== input.filtered.defaultBranch ||
    input.reconciliation.defaultBranch !== input.filtered.defaultBranch ||
    input.validation.defaultBranch !== input.filtered.defaultBranch
  ) {
    snapshotFailures.push("SNAPSHOT_BINDING_MISMATCH");
  }

  const candidateFailures: GateFailureCode[] = [];
  const unsupportedSchema = input.composition.schemaVersion !== 1 ||
    input.reconciliation.schemaVersion !== 1 || input.validation.schemaVersion !== 1;
  if (
    candidate === undefined || candidateSha256.length !== 64 ||
    sha256(input.composition.candidate) !== input.composition.candidateSha256.toLowerCase() ||
    input.reconciliation.candidateSha256?.toLowerCase() !== candidateSha256 ||
    input.validation.candidateSha256?.toLowerCase() !== candidateSha256 ||
    unsupportedSchema
  ) {
    candidateFailures.push(unsupportedSchema ? "SCHEMA_UNSUPPORTED" : "CANDIDATE_BINDING_MISMATCH");
  }

  const validationFailures: GateFailureCode[] = [];
  if (input.validation.status !== "PASS" || input.validation.blockingFailures.length > 0) {
    validationFailures.push("VALIDATION_NOT_PASSED");
  }
  if (input.validation.checks.length !== REQUIRED_VALIDATION_CHECKS.length) {
    validationFailures.push("VALIDATION_CHECK_MISSING");
  }
  const checkCounts = new Map<ValidationCheckId, number>();
  for (const validationCheck of input.validation.checks) {
    checkCounts.set(validationCheck.id, (checkCounts.get(validationCheck.id) ?? 0) + 1);
  }
  if (REQUIRED_VALIDATION_CHECKS.some((id) => checkCounts.get(id) !== 1)) {
    validationFailures.push("VALIDATION_CHECK_MISSING");
  }
  if (input.validation.checks.some((validationCheck) => validationCheck.status !== "PASS" || validationCheck.issues.length > 0)) {
    validationFailures.push("VALIDATION_CHECK_FAILED");
  }

  const evidenceFailures = validationFailuresFor(
    input.validation,
    EVIDENCE_CHECKS,
    "EVIDENCE_OR_COVERAGE_INVALID",
  );
  if (input.catalog.coverage.length !== 16 || input.catalog.issues.length > 0) {
    evidenceFailures.push("EVIDENCE_OR_COVERAGE_INVALID");
  }

  const preservationMatches = input.filtered.existingProfile.status === "absent"
    ? !input.reconciliation.existingProfilePreserved
    : input.filtered.existingProfile.status === "safe_to_parse" && input.reconciliation.existingProfilePreserved;
  const reconciliationFailures = [
    ...validationFailuresFor(input.validation, ["RECONCILIATION_COMPLETE"], "RECONCILIATION_UNSAFE"),
    ...validationFailuresFor(input.validation, ["FAILURE_PRESERVATION"], "PROFILE_PRESERVATION_INVALID"),
  ];
  if (
    !["FIRST_GENERATION", "CHANGED", "NO_CHANGES"].includes(input.reconciliation.status) ||
    input.reconciliation.candidate === undefined || input.reconciliation.issues.length > 0 ||
    !["absent", "safe_to_parse"].includes(input.filtered.existingProfile.status)
  ) {
    reconciliationFailures.push("RECONCILIATION_UNSAFE");
  }
  if (!preservationMatches) {
    reconciliationFailures.push("PROFILE_PRESERVATION_INVALID");
  }

  const securityFailures = validationFailuresFor(input.validation, SECURITY_CHECKS);
  if (input.filtered.scan.scanner === "unavailable") {
    securityFailures.push("SECURITY_SCAN_UNAVAILABLE");
  }
  if (input.filtered.scan.status === "failed") {
    securityFailures.push("SECURITY_SCAN_FAILED");
  }
  if (
    input.filtered.status === "blocked" || input.filtered.scan.status !== "complete" ||
    !input.filtered.scan.coverageComplete ||
    input.filtered.scan.expectedFileCount !== input.filtered.scan.scannedFileCount
  ) {
    securityFailures.push("SECURITY_SCAN_INCOMPLETE");
  }
  if (scannerVersion.length === 0) {
    securityFailures.push("SCANNER_VERSION_MISSING");
  }

  const artifactFailures: GateFailureCode[] = [];
  const changedPaths = input.changedFilePaths;
  if (
    !Array.isArray(changedPaths) || changedPaths.length > 1 ||
    changedPaths.some((path) => path !== TECHNICAL_PROFILE_PATH) ||
    (input.reconciliation.status !== "NO_CHANGES" && changedPaths.length !== 1) ||
    (input.reconciliation.status === "NO_CHANGES" && changedPaths.length !== 0)
  ) {
    artifactFailures.push("ARTIFACT_BOUNDARY_VIOLATION");
  }
  artifactFailures.push(...validationFailuresFor(
    input.validation,
    ["CHANGED_FILE_BOUNDARY"],
    "ARTIFACT_BOUNDARY_VIOLATION",
  ));

  const testFailures = failuresForAutomatedTests(input.automatedTests, testSuiteVersion, automatedTestBinding);
  const checks = [
    check("TARGET_BINDING", targetFailures),
    check("SNAPSHOT_BINDING", snapshotFailures),
    check("CANDIDATE_BINDING", candidateFailures),
    check("PROFILE_VALIDATION", [...validationFailures, ...validationFailuresFor(input.validation, PROFILE_CHECKS)]),
    check("EVIDENCE_COMPLETENESS", evidenceFailures),
    check("RECONCILIATION_SAFETY", reconciliationFailures),
    check("SECURITY", uniqueFailures(securityFailures)),
    check("ARTIFACT_BOUNDARY", uniqueFailures(artifactFailures)),
    check("AUTOMATED_TESTS", testFailures),
  ];
  const blockingFailures = checks.flatMap((item) => item.failureCodes.map((code) => ({ checkId: item.id, code })));
  const status = blockingFailures.length === 0 ? "PASS" : "BLOCKED";
  const proposalAuthorization: ProposalAuthorization | undefined = status === "PASS"
    ? { status: "AUTHORIZED", binding, allowedArtifactPath: TECHNICAL_PROFILE_PATH }
    : undefined;

  return {
    status,
    binding,
    checks,
    blockingFailures,
    validationResult: input.validation,
    automatedTestResult: sanitizedTestResult(input.automatedTests),
    securityScanResult: {
      scannerId: input.filtered.scan.scanner,
      ...(scannerVersion.length === 0 ? {} : { scannerVersion }),
      inputScanStatus: input.filtered.scan.status,
      expectedFileCount: input.filtered.scan.expectedFileCount,
      scannedFileCount: input.filtered.scan.scannedFileCount,
      coverageComplete: input.filtered.scan.coverageComplete,
      candidateScanStatus: validationCheckStatus(input.validation, "SECURITY_SCAN"),
    },
    ...(proposalAuthorization === undefined ? {} : { proposalAuthorization }),
  };
}

export function isGatePassBoundTo(
  gate: MandatoryGateResult,
  expected: GateBinding,
): boolean {
  const authorization = gate.proposalAuthorization;
  return gate.status === "PASS" && authorization?.status === "AUTHORIZED" &&
    gate.blockingFailures.length === 0 && gate.checks.length > 0 &&
    gate.checks.every((checkResult) => checkResult.status === "PASS" && checkResult.failureCodes.length === 0) &&
    sameBinding(gate.binding, expected) && sameBinding(authorization.binding, expected) &&
    authorization.allowedArtifactPath === TECHNICAL_PROFILE_PATH &&
    gate.validationResult.status === "PASS" && gate.validationResult.blockingFailures.length === 0 &&
    gate.validationResult.repositoryId.toLowerCase() === expected.repositoryId &&
    gate.validationResult.snapshotCommitSha.toLowerCase() === expected.snapshotCommitSha &&
    gate.validationResult.candidateSha256?.toLowerCase() === expected.candidateSha256 &&
    gate.validationResult.schemaVersion === expected.schemaVersion &&
    gate.securityScanResult.scannerId === expected.scannerId &&
    gate.securityScanResult.scannerVersion === expected.scannerVersion &&
    gate.securityScanResult.inputScanStatus === "complete" &&
    gate.securityScanResult.coverageComplete &&
    gate.securityScanResult.expectedFileCount === gate.securityScanResult.scannedFileCount &&
    gate.securityScanResult.candidateScanStatus === "PASS" &&
    gate.automatedTestResult.status === "PASS" &&
    gate.automatedTestResult.totalTests === REQUIRED_AUTOMATED_TEST_COUNT &&
    gate.automatedTestResult.passedTests === gate.automatedTestResult.totalTests &&
    gate.automatedTestResult.failedTests === 0 && gate.automatedTestResult.skippedTests === 0 &&
    gate.automatedTestResult.suiteVersion === expected.testSuiteVersion &&
    gate.automatedTestResult.binding !== undefined &&
    sameAutomatedTestBinding(gate.automatedTestResult.binding, {
      runId: expected.runId,
      targetRepository: expected.targetRepository,
      snapshotCommitSha: expected.snapshotCommitSha,
      candidateSha256: expected.candidateSha256,
      schemaVersion: expected.schemaVersion,
    });
}

function validationFailuresFor(
  validation: ValidationResult,
  ids: readonly ValidationCheckId[],
  failedCode: GateFailureCode = "VALIDATION_CHECK_FAILED",
): GateFailureCode[] {
  const failures: GateFailureCode[] = [];
  for (const id of ids) {
    const matches = validation.checks.filter((checkResult) => checkResult.id === id);
    if (matches.length !== 1) {
      failures.push("VALIDATION_CHECK_MISSING");
    } else if (matches[0]?.status !== "PASS" || matches[0].issues.length > 0) {
      failures.push(failedCode);
    }
  }
  return failures;
}

function validationCheckStatus(
  validation: ValidationResult,
  id: ValidationCheckId,
): "PASS" | "BLOCKED" | "NOT_RUN" {
  const matches = validation.checks.filter((checkResult) => checkResult.id === id);
  if (matches.length !== 1) {
    return "NOT_RUN";
  }
  return matches[0]?.status === "PASS" && matches[0].issues.length === 0 ? "PASS" : "BLOCKED";
}

function failuresForAutomatedTests(
  result: AutomatedTestResult | undefined,
  suiteVersion: string,
  expectedBinding: AutomatedTestBinding,
): GateFailureCode[] {
  if (result === undefined || result.status === "UNAVAILABLE") {
    return ["AUTOMATED_TESTS_UNAVAILABLE"];
  }
  if (result.status === "TIMEOUT") {
    return ["AUTOMATED_TESTS_TIMED_OUT"];
  }
  if (result.status === "CANCELLED") {
    return ["AUTOMATED_TESTS_CANCELLED"];
  }
  if (result.status === "SKIPPED") {
    return ["AUTOMATED_TESTS_SKIPPED"];
  }
  if (result.status === "FAIL") {
    return ["AUTOMATED_TESTS_FAILED"];
  }
  if (
    result.status !== "PASS" || suiteVersion !== AUTOMATED_TEST_SUITE_VERSION ||
    result.binding === undefined || !sameAutomatedTestBinding(result.binding, expectedBinding) ||
    !isCount(result.totalTests) || result.totalTests !== REQUIRED_AUTOMATED_TEST_COUNT ||
    !isCount(result.passedTests) || result.passedTests !== result.totalTests ||
    !isCount(result.failedTests) || result.failedTests !== 0 ||
    !isCount(result.skippedTests) || result.skippedTests !== 0
  ) {
    return ["AUTOMATED_TESTS_INDETERMINATE"];
  }
  return [];
}

function sanitizedTestResult(result: AutomatedTestResult | undefined): MandatoryGateResult["automatedTestResult"] {
  if (result === undefined) {
    return { status: "MISSING" };
  }
  const suiteVersion = safeVersion(result.suiteVersion);
  const binding = result.binding === undefined ? undefined : sanitizeAutomatedTestBinding(result.binding);
  return {
    status: result.status,
    ...(binding === undefined ? {} : { binding }),
    ...(suiteVersion === undefined ? {} : { suiteVersion }),
    ...(isCount(result.totalTests) ? { totalTests: result.totalTests } : {}),
    ...(isCount(result.passedTests) ? { passedTests: result.passedTests } : {}),
    ...(isCount(result.failedTests) ? { failedTests: result.failedTests } : {}),
    ...(isCount(result.skippedTests) ? { skippedTests: result.skippedTests } : {}),
  };
}

function check(id: GateCheckId, failures: GateFailureCode[]): GateCheckResult {
  const failureCodes = uniqueFailures(failures);
  return { id, status: failureCodes.length === 0 ? "PASS" : "BLOCKED", failureCodes };
}

function uniqueFailures(failures: GateFailureCode[]): GateFailureCode[] {
  return [...new Set(failures)];
}

function sameBinding(left: GateBinding, right: GateBinding): boolean {
  return left.runId === right.runId &&
    left.targetRepository === right.targetRepository &&
    left.repositoryId === right.repositoryId &&
    left.githubRepositoryId === right.githubRepositoryId &&
    left.snapshotCommitSha === right.snapshotCommitSha &&
    left.candidateSha256 === right.candidateSha256 &&
    left.schemaVersion === right.schemaVersion &&
    left.gateVersion === right.gateVersion &&
    left.validatorVersion === right.validatorVersion &&
    left.testSuiteVersion === right.testSuiteVersion &&
    left.scannerId === right.scannerId &&
    left.scannerVersion === right.scannerVersion;
}

function safeVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function sameAutomatedTestBinding(left: AutomatedTestBinding, right: AutomatedTestBinding): boolean {
  return left.runId === right.runId &&
    left.targetRepository === right.targetRepository &&
    left.snapshotCommitSha === right.snapshotCommitSha &&
    left.candidateSha256 === right.candidateSha256 &&
    left.schemaVersion === right.schemaVersion;
}

function sanitizeAutomatedTestBinding(value: AutomatedTestBinding): AutomatedTestBinding | undefined {
  if (
    typeof value.runId !== "string" || !/^run-[0-9a-f-]{36}$/i.test(value.runId) ||
    typeof value.targetRepository !== "string" || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(value.targetRepository) ||
    typeof value.snapshotCommitSha !== "string" || !/^[0-9a-f]{40}$/.test(value.snapshotCommitSha) ||
    typeof value.candidateSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.candidateSha256) ||
    !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1
  ) {
    return undefined;
  }
  return { ...value };
}