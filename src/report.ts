import { PROFILE_SECTIONS } from "./evidence/types.js";
import { TECHNICAL_PROFILE_PATH } from "./collection.js";
import type { GitHubRepositoryMetadata } from "./github-client.js";
import type { TechnologyAnalysisResult } from "./analyzers/types.js";
import type { ProfileCompositionResult } from "./composer.js";
import type { EvidenceCatalogResult } from "./evidence/types.js";
import type { RepositoryFilterResult } from "./filter.js";
import type { ProfileReconciliationResult } from "./reconciler.js";
import type { ValidationResult } from "./validation.js";
import type { MandatoryGateResult } from "./gate.js";
import type { ProposalResult } from "./proposal.js";

export type RunReportOutcome = "PROPOSED" | "NO_CHANGES" | "BLOCKED" | "FAILED";
export type RunReportStageId =
  | "COLLECTION"
  | "FILTERING"
  | "ANALYSIS"
  | "EVIDENCE"
  | "COMPOSITION"
  | "RECONCILIATION"
  | "VALIDATION"
  | "GATE"
  | "PROPOSAL";
export type RunReportStageStatus = "PASS" | "PARTIAL" | "BLOCKED" | "FAILED" | "NOT_RUN";

export interface RunReportCounts {
  filesDiscovered: number;
  filesEligible: number;
  filesExcluded: number;
  filesRejectedForSecurity: number;
  observations: number;
  evidenceItems: number;
  profileFields: number;
  reconciliationChanges: number;
  validationChecks: number;
  gateChecks: number;
  proposalChangedFiles: number;
}

export interface RunReportStage {
  id: RunReportStageId;
  status: RunReportStageStatus;
  counts: Partial<RunReportCounts>;
  failureCodes: string[];
}

export interface SanitizedRunError {
  code: string;
  stage: RunReportStageId;
  retryable: boolean;
  message: string;
  correlationId?: string;
}

export interface SanitizedRunReport {
  reportVersion: "IMP-15/1";
  outcome: RunReportOutcome;
  runId?: string;
  targetRepository?: string;
  githubRepositoryId?: number;
  executionContext?: "local" | "actions";
  startedAt?: string;
  completedAt?: string;
  defaultBranch?: string;
  snapshotCommitSha?: string;
  targetHeadSha?: string;
  staleSnapshot: boolean;
  candidateSha256?: string;
  schemaVersion?: number;
  validatorVersion?: string;
  testSuiteVersion?: string;
  scannerVersion?: string;
  counts: RunReportCounts;
  stages: RunReportStage[];
  validation?: {
    status: string;
    failedCheckCodes: string[];
  };
  gate?: {
    status: string;
    failedCheckCodes: string[];
  };
  automatedTests?: {
    status: string;
    suiteVersion?: string;
    totalTests?: number;
    passedTests?: number;
    failedTests?: number;
    skippedTests?: number;
  };
  securityScan?: {
    scanner: string;
    status: string;
    expectedFileCount: number;
    scannedFileCount: number;
    coverageComplete: boolean;
    candidateStatus: string;
  };
  proposal?: {
    status: string;
    branchName?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    changedFileCount: number;
    changedFilePaths: string[];
    staleSnapshot: boolean;
  };
  errors: SanitizedRunError[];
}

export interface RunReportSource {
  ok: boolean;
  context?: {
    runId?: string;
    normalizedRepositoryId?: string;
    executionContext?: "local" | "actions";
    startedAt?: string;
    defaultBranch?: string;
    snapshotCommitSha?: string;
    stage?: string;
    status?: string;
  };
  repository?: GitHubRepositoryMetadata;
  filtered?: RepositoryFilterResult;
  analysis?: TechnologyAnalysisResult;
  evidenceCatalog?: EvidenceCatalogResult;
  composition?: ProfileCompositionResult;
  reconciliation?: ProfileReconciliationResult;
  validation?: ValidationResult;
  gate?: MandatoryGateResult;
  proposal?: ProposalResult;
  error?: { code: string };
}

const REPORT_STAGES: readonly RunReportStageId[] = [
  "COLLECTION", "FILTERING", "ANALYSIS", "EVIDENCE", "COMPOSITION",
  "RECONCILIATION", "VALIDATION", "GATE", "PROPOSAL",
];

const SAFE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_CONFIGURATION: "Run configuration was invalid.",
  RUN_INITIALIZATION_FAILED: "The run could not be initialized safely.",
  BUSY: "A proposal-capable run is already active for this repository.",
  RUN_TIMEOUT: "The run exceeded its configured execution deadline.",
  REPOSITORY_NOT_FOUND: "The configured repository could not be read.",
  DEFAULT_BRANCH_COMMIT_MISSING: "The repository default-branch snapshot could not be read.",
  TREE_RETRIEVAL_FAILED: "The repository snapshot tree could not be read.",
  BLOB_RETRIEVAL_FAILED: "A repository object could not be read.",
  FILE_RETRIEVAL_FAILED: "A repository file could not be read.",
  INVALID_GITHUB_RESPONSE: "The repository service returned invalid metadata.",
  INVALID_RESPONSE: "The repository service returned an invalid response.",
  MISSING_COMMIT_METADATA: "The repository snapshot metadata was incomplete.",
  CREDENTIAL_CONFIGURATION_INVALID: "The configured repository access was invalid.",
  CREDENTIAL_STORE_UNAVAILABLE: "The configured repository credential store was unavailable.",
  AUTHENTICATION_FAILED: "Repository authentication failed.",
  AUTHORIZATION_FAILED: "Repository access was denied.",
  ACCESS_DENIED: "Repository access was denied.",
  NETWORK_FAILURE: "A repository request failed.",
  SERVICE_UNAVAILABLE: "The repository service was unavailable.",
  RATE_LIMITED: "The repository request limit was reached.",
  SNAPSHOT_INCONSISTENT: "The repository snapshot could not be verified.",
  COLLECTION_INCOMPLETE: "Repository collection was incomplete.",
  SCANNER_UNAVAILABLE: "The required security scanner was unavailable.",
  SCANNER_FAILED: "The security scan failed.",
  SCANNER_TIMEOUT: "The security scan timed out.",
  SCAN_INCOMPLETE: "The security scan did not cover all required inputs.",
  EXISTING_PROFILE_SECRET: "The existing profile failed a security check.",
  RECONCILIATION_BLOCKED: "Profile reconciliation was blocked.",
  RECONCILIATION_FAILED: "Profile reconciliation failed.",
  VALIDATION_BLOCKED: "Profile validation was blocked.",
  VALIDATION_FAILED: "Profile validation failed.",
  GATE_BLOCKED: "The mandatory validation gate did not pass.",
  PROPOSAL_BLOCKED: "Proposal capability was unavailable or invalid.",
  PROPOSAL_STALE: "The validated repository snapshot became stale.",
  PROPOSAL_FAILED: "The proposal could not be completed safely.",
  PROPOSAL_TIMED_OUT: "A proposal operation exceeded its configured timeout.",
  OPEN_PROPOSAL_EXISTS: "An exact matching open proposal already exists.",
  OPEN_PROPOSAL_CONFLICT: "A different open technical profile proposal exists.",
  OPEN_PROPOSAL_STATE_UNVERIFIED: "Open proposal state could not be verified.",
  REPORT_UNSAFE: "The report failed a safety check and was redacted.",
  RUN_FAILED: "The run could not be completed safely.",
};

const SENSITIVE_REPORT_VALUE = /(?:gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|xox[baprs]-[a-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization\s*:\s*bearer\s+\S+|(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|connection[_-]?string)\s*[:=]\s*\S+|https?:\/\/[^\s/@:]+:[^\s/@]+@)/i;

export function createSanitizedRunReport(
  source: RunReportSource,
  completedAt?: string,
): SanitizedRunReport {
  try {
    const report = buildReport(source, completedAt);
    return validateRunReport(report) ? report : safeFallbackReport(report.runId);
  } catch {
    return safeFallbackReport();
  }
}

function buildReport(source: RunReportSource, completedAt?: string): SanitizedRunReport {
  const runId = safeRunId(source.context?.runId ?? source.gate?.binding?.runId);
  const repositoryId = safeRepositoryId(
    source.repository?.normalizedRepositoryId ?? source.context?.normalizedRepositoryId ?? source.filtered?.repositoryId,
  );
  const defaultBranch = safeBranch(source.repository?.defaultBranch ?? source.filtered?.defaultBranch ?? source.context?.defaultBranch);
  const snapshotCommitSha = safeSha(
    source.gate?.binding?.snapshotCommitSha ?? source.filtered?.snapshotCommitSha ?? source.context?.snapshotCommitSha,
  );
  const candidateSha256 = safeDigest(
    source.proposal?.candidateSha256 ?? source.gate?.binding?.candidateSha256 ?? source.reconciliation?.candidateSha256 ?? source.composition?.candidateSha256,
  );
  const targetHeadSha = source.proposal?.status === "CREATED" || source.proposal?.status === "NO_CHANGES"
    ? snapshotCommitSha
    : undefined;
  const staleSnapshot = source.proposal?.status === "STALE";
  const failureStage = source.ok ? undefined : failureStageFor(source);
  const counts = createCounts(source);
  const validationFailures = uniqueStrings(source.validation?.blockingFailures.map((issue) => issue.code) ?? []);
  const gateFailures = uniqueStrings(source.gate?.blockingFailures.map((failure) => failure.code) ?? []);
  const proposalPaths = safeProposalPaths(source.proposal?.changedFiles ?? []);
  const stages = REPORT_STAGES.map((id) => createStage(source, id, failureStage, validationFailures, gateFailures));
  const errors = createErrors(source, runId);
  const startedAt = safeTimestamp(source.context?.startedAt);
  const finishedAt = safeTimestamp(completedAt);
  const schemaVersion = source.composition?.schemaVersion;
  const validatorVersion = safeVersion(source.gate?.binding?.validatorVersion);
  const testSuiteVersion = safeVersion(source.gate?.binding?.testSuiteVersion);
  const scannerVersion = safeVersion(source.gate?.binding?.scannerVersion);
  if (source.proposal !== undefined && proposalPaths === undefined) {
    errors.push(safeError("ARTIFACT_BOUNDARY_VIOLATION", "PROPOSAL", runId));
  }
  const outcome = reportOutcome(source);
  const report: SanitizedRunReport = {
    reportVersion: "IMP-15/1",
    outcome: proposalPaths === undefined ? "FAILED" : outcome,
    ...(runId === undefined ? {} : { runId }),
    ...(repositoryId === undefined ? {} : { targetRepository: repositoryId }),
    ...(source.repository !== undefined && Number.isSafeInteger(source.repository.repositoryId) && source.repository.repositoryId > 0
      ? { githubRepositoryId: source.repository.repositoryId }
      : {}),
    ...(source.context?.executionContext === "local" || source.context?.executionContext === "actions"
      ? { executionContext: source.context.executionContext }
      : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { completedAt: finishedAt }),
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    ...(snapshotCommitSha === undefined ? {} : { snapshotCommitSha }),
    ...(targetHeadSha === undefined ? {} : { targetHeadSha }),
    staleSnapshot,
    ...(candidateSha256 === undefined ? {} : { candidateSha256 }),
    ...(schemaVersion === undefined || !Number.isSafeInteger(schemaVersion) ? {} : { schemaVersion }),
    ...(validatorVersion === undefined ? {} : { validatorVersion }),
    ...(testSuiteVersion === undefined ? {} : { testSuiteVersion }),
    ...(scannerVersion === undefined ? {} : { scannerVersion }),
    counts,
    stages,
    ...(source.validation === undefined ? {} : {
      validation: { status: safeStatus(source.validation.status), failedCheckCodes: validationFailures },
    }),
    ...(source.gate === undefined ? {} : {
      gate: { status: safeStatus(source.gate.status), failedCheckCodes: gateFailures },
    }),
    ...(source.gate === undefined ? {} : { automatedTests: safeAutomatedTests(source.gate) }),
    ...(source.gate === undefined ? {} : { securityScan: safeSecurityScan(source.gate) }),
    ...(source.proposal === undefined ? {} : {
      proposal: safeProposal(source.proposal, repositoryId, proposalPaths ?? []),
    }),
    errors,
  };
  return report;
}

function createCounts(source: RunReportSource): RunReportCounts {
  const reconciliation = source.reconciliation;
  const filtered = source.filtered;
  return {
    filesDiscovered: count(filtered?.fileRecords.length),
    filesEligible: count(filtered?.analysisFiles.length),
    filesExcluded: count(filtered?.exclusionRecords.length),
    filesRejectedForSecurity: count(filtered?.securityFindings.length),
    observations: count(source.analysis?.observations.length),
    evidenceItems: count(source.evidenceCatalog?.evidence.length),
    profileFields: source.validation?.status === "PASS" ? PROFILE_SECTIONS.length : 0,
    reconciliationChanges: count(reconciliation === undefined ? undefined :
      reconciliation.additions.length + reconciliation.modifications.length + reconciliation.removals.length),
    validationChecks: count(source.validation?.checks.length),
    gateChecks: count(source.gate?.checks.length),
    proposalChangedFiles: count(source.proposal?.changedFiles.length),
  };
}

function createStage(
  source: RunReportSource,
  id: RunReportStageId,
  failureStage: RunReportStageId | undefined,
  validationFailures: string[],
  gateFailures: string[],
): RunReportStage {
  const failureCodes: string[] = [];
  let status: RunReportStageStatus = "NOT_RUN";
  if (source.ok) {
    status = successfulStageStatus(source, id);
  } else if (failureStage !== undefined) {
    const stageIndex = REPORT_STAGES.indexOf(id);
    const failureIndex = REPORT_STAGES.indexOf(failureStage);
    if (stageIndex < failureIndex) {
      status = successfulStageStatus(source, id);
    } else if (stageIndex === failureIndex) {
      status = failureStageStatus(source, id);
      if (id === "VALIDATION") failureCodes.push(...validationFailures);
      if (id === "GATE") failureCodes.push(...gateFailures);
      if (id === "PROPOSAL" && source.proposal?.failureCode !== undefined) {
        failureCodes.push(safeErrorCode(source.proposal.failureCode));
      }
    }
  }
  return {
    id,
    status,
    counts: stageCounts(source, id),
    failureCodes: uniqueStrings(failureCodes),
  };
}

function successfulStageStatus(source: RunReportSource, id: RunReportStageId): RunReportStageStatus {
  switch (id) {
    case "COLLECTION":
      return source.filtered?.status === "partial" ? "PARTIAL" : hasStageData(source, id) ? "PASS" : "NOT_RUN";
    case "FILTERING":
      return source.filtered === undefined ? "NOT_RUN" : source.filtered.status === "blocked" ? "BLOCKED" : source.filtered.status === "partial" ? "PARTIAL" : "PASS";
    case "ANALYSIS":
      return source.analysis === undefined ? "NOT_RUN" : source.analysis.issues.length > 0 ? "PARTIAL" : "PASS";
    case "EVIDENCE":
      return source.evidenceCatalog === undefined ? "NOT_RUN" : source.evidenceCatalog.issues.length > 0 ? "PARTIAL" : "PASS";
    case "COMPOSITION":
      return source.composition === undefined ? "NOT_RUN" : "PASS";
    case "RECONCILIATION":
      return source.reconciliation === undefined ? "NOT_RUN" : source.reconciliation.status === "BLOCKED" ? "BLOCKED" : source.reconciliation.status === "FAILED" ? "FAILED" : "PASS";
    case "VALIDATION":
      return source.validation === undefined ? "NOT_RUN" : source.validation.status === "PASS" ? "PASS" : source.validation.status === "BLOCKED" ? "BLOCKED" : "FAILED";
    case "GATE":
      return source.gate === undefined ? "NOT_RUN" : source.gate.status === "PASS" ? "PASS" : "BLOCKED";
    case "PROPOSAL":
      return source.proposal === undefined ? "NOT_RUN" : source.proposal.status === "CREATED" || source.proposal.status === "NO_CHANGES" ? "PASS" : source.proposal.status === "BLOCKED" || source.proposal.status === "STALE" ? "BLOCKED" : "FAILED";
  }
}

function failureStageStatus(source: RunReportSource, id: RunReportStageId): RunReportStageStatus {
  if (id === "FILTERING" && source.filtered?.status === "blocked") return "BLOCKED";
  if (id === "RECONCILIATION" && source.reconciliation?.status === "BLOCKED") return "BLOCKED";
  if (id === "VALIDATION" && source.validation?.status === "BLOCKED") return "BLOCKED";
  if (id === "GATE") return "BLOCKED";
  if (id === "PROPOSAL" && (source.proposal?.status === "BLOCKED" || source.proposal?.status === "STALE")) return "BLOCKED";
  return "FAILED";
}

function hasStageData(source: RunReportSource, id: RunReportStageId): boolean {
  switch (id) {
    case "COLLECTION":
    case "FILTERING": return source.filtered !== undefined;
    case "ANALYSIS": return source.analysis !== undefined;
    case "EVIDENCE": return source.evidenceCatalog !== undefined;
    case "COMPOSITION": return source.composition !== undefined;
    case "RECONCILIATION": return source.reconciliation !== undefined;
    case "VALIDATION": return source.validation !== undefined;
    case "GATE": return source.gate !== undefined;
    case "PROPOSAL": return source.proposal !== undefined;
  }
}

function stageCounts(source: RunReportSource, id: RunReportStageId): Partial<RunReportCounts> {
  const counts = createCounts(source);
  switch (id) {
    case "COLLECTION": return { filesDiscovered: counts.filesDiscovered };
    case "FILTERING": return { filesEligible: counts.filesEligible, filesExcluded: counts.filesExcluded, filesRejectedForSecurity: counts.filesRejectedForSecurity };
    case "ANALYSIS": return { observations: counts.observations };
    case "EVIDENCE": return { evidenceItems: counts.evidenceItems };
    case "COMPOSITION": return { profileFields: counts.profileFields };
    case "RECONCILIATION": return { reconciliationChanges: counts.reconciliationChanges };
    case "VALIDATION": return { validationChecks: counts.validationChecks };
    case "GATE": return { gateChecks: counts.gateChecks };
    case "PROPOSAL": return { proposalChangedFiles: counts.proposalChangedFiles };
  }
}

function failureStageFor(source: RunReportSource): RunReportStageId {
  if (source.proposal !== undefined || source.error?.code.startsWith("PROPOSAL_")) return "PROPOSAL";
  if (source.gate !== undefined || source.error?.code === "GATE_BLOCKED") return "GATE";
  if (source.validation !== undefined || source.error?.code.startsWith("VALIDATION_")) return "VALIDATION";
  if (source.reconciliation !== undefined || source.error?.code.startsWith("RECONCILIATION_")) return "RECONCILIATION";
  if (source.filtered?.status === "blocked" || isFilterFailure(source.error?.code)) return "FILTERING";
  if (source.error?.code.includes("EVIDENCE") || source.context?.stage === "ANALYZED") return "EVIDENCE";
  if (source.error?.code.includes("COMPOSER") || source.context?.stage === "EVIDENCED") return "COMPOSITION";
  return "COLLECTION";
}

function isFilterFailure(code: string | undefined): boolean {
  return code !== undefined && [
    "SCANNER_UNAVAILABLE", "SCANNER_FAILED", "SCAN_INCOMPLETE", "INVALID_SCAN_RESULT",
    "SCANNER_BOUNDARY_INVALID", "EXISTING_PROFILE_SECRET", "EXISTING_PROFILE_UNAVAILABLE", "COLLECTION_INCOMPLETE",
  ].includes(code);
}

function reportOutcome(source: RunReportSource): RunReportOutcome {
  if (source.ok) {
    return source.proposal?.status === "NO_CHANGES" ? "NO_CHANGES" : "PROPOSED";
  }
  if (
    source.gate?.status === "BLOCKED" ||
    source.proposal?.status === "STALE" || source.error?.code === "GATE_BLOCKED" ||
    source.error?.code === "PROPOSAL_STALE" ||
    isFilterFailure(source.error?.code) || source.error?.code === "RECONCILIATION_BLOCKED" ||
    source.error?.code === "VALIDATION_BLOCKED" || source.validation?.status === "BLOCKED" || source.validation?.status === "FAIL"
  ) {
    return "BLOCKED";
  }
  return "FAILED";
}

function createErrors(source: RunReportSource, runId: string | undefined): SanitizedRunError[] {
  const errors: SanitizedRunError[] = [];
  if (!source.ok && source.error !== undefined) {
    errors.push(safeError(source.error.code, failureStageFor(source), runId));
  }
  for (const failure of source.gate?.blockingFailures ?? []) {
    errors.push(safeError(failure.code, reportStageForGateCheck(failure.checkId), runId));
  }
  for (const issue of source.validation?.blockingFailures ?? []) {
    errors.push(safeError(issue.code, "VALIDATION", runId));
  }
  if (source.proposal?.failureCode !== undefined) {
    errors.push(safeError(source.proposal.failureCode, "PROPOSAL", runId));
  }
  return deduplicateErrors(errors);
}

function reportStageForGateCheck(checkId: string): RunReportStageId {
  if (checkId === "SECURITY") return "FILTERING";
  if (checkId === "TARGET_BINDING" || checkId === "SNAPSHOT_BINDING" || checkId === "CANDIDATE_BINDING") return "GATE";
  if (checkId === "PROFILE_VALIDATION") return "VALIDATION";
  if (checkId === "EVIDENCE_COMPLETENESS") return "EVIDENCE";
  if (checkId === "RECONCILIATION_SAFETY") return "RECONCILIATION";
  if (checkId === "ARTIFACT_BOUNDARY") return "PROPOSAL";
  return "GATE";
}

function safeError(code: string, stage: RunReportStageId, runId: string | undefined): SanitizedRunError {
  const safeCode = safeErrorCode(code);
  return {
    code: safeCode,
    stage,
    retryable: false,
    message: SAFE_ERROR_MESSAGES[safeCode] ?? SAFE_ERROR_MESSAGES.RUN_FAILED as string,
    ...(runId === undefined ? {} : { correlationId: runId }),
  };
}

function safeErrorCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "RUN_FAILED";
}

function deduplicateErrors(errors: SanitizedRunError[]): SanitizedRunError[] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.stage}\0${error.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map(safeErrorCode))];
}

function safeAutomatedTests(gate: MandatoryGateResult): NonNullable<SanitizedRunReport["automatedTests"]> {
  const tests = gate.automatedTestResult;
  if (typeof tests !== "object" || tests === null) {
    return { status: "MISSING" };
  }
  const suiteVersion = safeVersion(tests.suiteVersion);
  return {
    status: safeStatus(tests.status),
    ...(suiteVersion === undefined ? {} : { suiteVersion }),
    ...(isCount(tests.totalTests) ? { totalTests: tests.totalTests } : {}),
    ...(isCount(tests.passedTests) ? { passedTests: tests.passedTests } : {}),
    ...(isCount(tests.failedTests) ? { failedTests: tests.failedTests } : {}),
    ...(isCount(tests.skippedTests) ? { skippedTests: tests.skippedTests } : {}),
  };
}

function safeSecurityScan(gate: MandatoryGateResult): NonNullable<SanitizedRunReport["securityScan"]> {
  const scan = gate.securityScanResult;
  if (typeof scan !== "object" || scan === null) {
    return {
      scanner: "unavailable",
      status: "failed",
      expectedFileCount: 0,
      scannedFileCount: 0,
      coverageComplete: false,
      candidateStatus: "NOT_RUN",
    };
  }
  return {
    scanner: scan.scannerId,
    status: safeScanStatus(scan.inputScanStatus),
    expectedFileCount: count(scan.expectedFileCount),
    scannedFileCount: count(scan.scannedFileCount),
    coverageComplete: scan.coverageComplete === true,
    candidateStatus: safeStatus(scan.candidateScanStatus),
  };
}

function safeProposal(
  proposal: ProposalResult,
  repositoryId: string | undefined,
  changedPaths: string[],
): NonNullable<SanitizedRunReport["proposal"]> {
  const branchName = safeBranchName(proposal.branchName);
  const pullRequestUrl = safePullRequestUrl(proposal.pullRequest?.url, repositoryId);
  const pullRequestNumber = proposal.pullRequest?.number;
  return {
    status: safeStatus(proposal.status),
    ...(branchName === undefined ? {} : { branchName }),
    ...(pullRequestUrl === undefined || pullRequestNumber === undefined ||
      !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1
      ? {} : { pullRequestNumber, pullRequestUrl }),
    changedFileCount: changedPaths.length,
    changedFilePaths: changedPaths,
    staleSnapshot: proposal.status === "STALE",
  };
}

function safeProposalPaths(paths: readonly string[]): string[] | undefined {
  if (paths.length > 1 || paths.some((path) => path !== TECHNICAL_PROFILE_PATH)) return undefined;
  return [...paths];
}

function safePullRequestUrl(value: string | undefined, repositoryId: string | undefined): string | undefined {
  if (value === undefined || repositoryId === undefined) return undefined;
  try {
    const url = new URL(value);
    const expectedPathPattern = new RegExp(`^/${escapeRegExp(repositoryId)}/pull/[1-9][0-9]*$`, "i");
    return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "" && expectedPathPattern.test(url.pathname)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeRunId(value: string | undefined): string | undefined {
  return typeof value === "string" && /^run-[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function safeRepositoryId(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value) && !SENSITIVE_REPORT_VALUE.test(value)
    ? value.toLowerCase()
    : undefined;
}

function safeSha(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}

function safeDigest(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : undefined;
}

function safeBranch(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..") &&
    !SENSITIVE_REPORT_VALUE.test(value) ? value : undefined;
}

function safeBranchName(value: string | undefined): string | undefined {
  return typeof value === "string" && /^docs-sync\/technical-profile\/[a-z0-9-]+-[0-9a-f]{12}$/.test(value)
    ? value
    : undefined;
}

function safeTimestamp(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeVersion(value: string | undefined): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function safeStatus(value: string): string {
  return ["PASS", "FAIL", "BLOCKED", "NOT_RUN", "PROPOSED", "NO_CHANGES", "CREATED", "STALE", "FAILED", "MISSING", "UNAVAILABLE", "INDETERMINATE", "TIMEOUT", "CANCELLED", "SKIPPED"].includes(value)
    ? value
    : "UNKNOWN";
}

function safeScanStatus(value: string): string {
  return ["complete", "incomplete", "failed"].includes(value) ? value : "unknown";
}

function count(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value as number : 0;
}

function isCount(value: number | undefined): boolean {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateRunReport(report: SanitizedRunReport): boolean {
  const allowedKeys = new Set([
    "reportVersion", "outcome", "runId", "targetRepository", "githubRepositoryId", "executionContext",
    "startedAt", "completedAt", "defaultBranch", "snapshotCommitSha", "targetHeadSha", "staleSnapshot",
    "candidateSha256", "schemaVersion", "validatorVersion", "testSuiteVersion", "scannerVersion", "counts",
    "stages", "validation", "gate", "automatedTests", "securityScan", "proposal", "errors",
  ]);
  if (!hasExactKeys(report, allowedKeys, ["reportVersion", "outcome", "staleSnapshot", "counts", "stages", "errors"])) return false;
  if (
    report.reportVersion !== "IMP-15/1" ||
    !["PROPOSED", "NO_CHANGES", "BLOCKED", "FAILED"].includes(report.outcome) ||
    (report.runId !== undefined && safeRunId(report.runId) === undefined) ||
    (report.targetRepository !== undefined && safeRepositoryId(report.targetRepository) !== report.targetRepository) ||
    (report.githubRepositoryId !== undefined && (!Number.isSafeInteger(report.githubRepositoryId) || report.githubRepositoryId < 1)) ||
    (report.startedAt !== undefined && safeTimestamp(report.startedAt) !== report.startedAt) ||
    (report.completedAt !== undefined && safeTimestamp(report.completedAt) !== report.completedAt) ||
    (report.defaultBranch !== undefined && safeBranch(report.defaultBranch) !== report.defaultBranch) ||
    (report.snapshotCommitSha !== undefined && safeSha(report.snapshotCommitSha) !== report.snapshotCommitSha) ||
    (report.targetHeadSha !== undefined && safeSha(report.targetHeadSha) !== report.targetHeadSha) ||
    (report.candidateSha256 !== undefined && safeDigest(report.candidateSha256) !== report.candidateSha256) ||
    (report.schemaVersion !== undefined && (!Number.isSafeInteger(report.schemaVersion) || report.schemaVersion < 1)) ||
    (report.validatorVersion !== undefined && safeVersion(report.validatorVersion) !== report.validatorVersion) ||
    (report.testSuiteVersion !== undefined && safeVersion(report.testSuiteVersion) !== report.testSuiteVersion) ||
    (report.scannerVersion !== undefined && safeVersion(report.scannerVersion) !== report.scannerVersion) ||
    !isSafeCounts(report.counts) ||
    !Array.isArray(report.stages) || report.stages.length !== REPORT_STAGES.length ||
    report.stages.some((stage, index) =>
      !hasExactKeys(stage, new Set(["id", "status", "counts", "failureCodes"]), ["id", "status", "counts", "failureCodes"]) ||
      stage.id !== REPORT_STAGES[index] || !isReportStageStatus(stage.status) ||
      !isSafePartialCounts(stage.counts) || !Array.isArray(stage.failureCodes) ||
      stage.failureCodes.some((code) => !isSafeCode(code))) ||
    (report.validation !== undefined && (
      !hasExactKeys(report.validation, new Set(["status", "failedCheckCodes"]), ["status", "failedCheckCodes"]) ||
      !["PASS", "FAIL", "BLOCKED", "NOT_RUN"].includes(report.validation.status) ||
      !report.validation.failedCheckCodes.every(isSafeCode)
    )) ||
    (report.gate !== undefined && (
      !hasExactKeys(report.gate, new Set(["status", "failedCheckCodes"]), ["status", "failedCheckCodes"]) ||
      !["PASS", "BLOCKED"].includes(report.gate.status) ||
      !report.gate.failedCheckCodes.every(isSafeCode)
    )) ||
    (report.automatedTests !== undefined && (
      !hasExactKeys(report.automatedTests, new Set(["status", "suiteVersion", "totalTests", "passedTests", "failedTests", "skippedTests"]), ["status"]) ||
      !["PASS", "FAIL", "UNAVAILABLE", "INDETERMINATE", "TIMEOUT", "CANCELLED", "SKIPPED", "MISSING"].includes(report.automatedTests.status) ||
      (report.automatedTests.suiteVersion !== undefined && safeVersion(report.automatedTests.suiteVersion) !== report.automatedTests.suiteVersion) ||
      [report.automatedTests.totalTests, report.automatedTests.passedTests, report.automatedTests.failedTests, report.automatedTests.skippedTests]
        .some((value) => value !== undefined && !isCount(value))
    )) ||
    (report.securityScan !== undefined && (
      !hasExactKeys(report.securityScan, new Set(["scanner", "status", "expectedFileCount", "scannedFileCount", "coverageComplete", "candidateStatus"]), ["scanner", "status", "expectedFileCount", "scannedFileCount", "coverageComplete", "candidateStatus"]) ||
      !["gitleaks", "unavailable", "test_double"].includes(report.securityScan.scanner) ||
      !["complete", "incomplete", "failed"].includes(report.securityScan.status) ||
      !["PASS", "BLOCKED", "NOT_RUN"].includes(report.securityScan.candidateStatus) ||
      !isCount(report.securityScan.expectedFileCount) || !isCount(report.securityScan.scannedFileCount) ||
      typeof report.securityScan.coverageComplete !== "boolean"
    )) ||
    (report.proposal !== undefined && (
      !hasExactKeys(report.proposal, new Set(["status", "branchName", "pullRequestNumber", "pullRequestUrl", "changedFileCount", "changedFilePaths", "staleSnapshot"]), ["status", "changedFileCount", "changedFilePaths", "staleSnapshot"]) ||
      !["CREATED", "NO_CHANGES", "BLOCKED", "STALE", "FAILED"].includes(report.proposal.status) ||
      (report.proposal.branchName !== undefined && safeBranchName(report.proposal.branchName) !== report.proposal.branchName) ||
      (report.proposal.pullRequestUrl !== undefined && safePullRequestUrl(report.proposal.pullRequestUrl, report.targetRepository) !== report.proposal.pullRequestUrl) ||
      (report.proposal.pullRequestNumber !== undefined && (!Number.isSafeInteger(report.proposal.pullRequestNumber) || report.proposal.pullRequestNumber < 1)) ||
      !isCount(report.proposal.changedFileCount) || report.proposal.changedFileCount !== report.proposal.changedFilePaths.length ||
      report.proposal.changedFilePaths.length > 1 || report.proposal.changedFilePaths.some((path) => path !== TECHNICAL_PROFILE_PATH) ||
      typeof report.proposal.staleSnapshot !== "boolean"
    )) ||
    !Array.isArray(report.errors) || report.errors.some((error) =>
      !hasExactKeys(error, new Set(["code", "stage", "retryable", "message", "correlationId"]), ["code", "stage", "retryable", "message"]) ||
      !isSafeCode(error.code) || !REPORT_STAGES.includes(error.stage) ||
      (error.correlationId !== undefined && safeRunId(error.correlationId) !== error.correlationId) ||
      error.message !== (SAFE_ERROR_MESSAGES[error.code] ?? SAFE_ERROR_MESSAGES.RUN_FAILED) || error.retryable !== false)
  ) {
    return false;
  }
  return !SENSITIVE_REPORT_VALUE.test(JSON.stringify(report));
}

function safeFallbackReport(candidateRunId?: string): SanitizedRunReport {
  const runId = safeRunId(candidateRunId);
  return {
    reportVersion: "IMP-15/1",
    outcome: "FAILED",
    ...(runId === undefined ? {} : { runId }),
    staleSnapshot: false,
    counts: zeroCounts(),
    stages: REPORT_STAGES.map((id) => ({ id, status: "NOT_RUN", counts: {}, failureCodes: [] })),
    errors: [safeError("REPORT_UNSAFE", "PROPOSAL", runId)],
  };
}

function zeroCounts(): RunReportCounts {
  return {
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
  };
}

function isReportStageStatus(value: string): boolean {
  return ["PASS", "PARTIAL", "BLOCKED", "FAILED", "NOT_RUN"].includes(value);
}

function hasExactKeys(value: object, allowed: ReadonlySet<string>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

function isSafeCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function isSafeCounts(value: RunReportCounts): boolean {
  const keys = [
    "filesDiscovered", "filesEligible", "filesExcluded", "filesRejectedForSecurity", "observations",
    "evidenceItems", "profileFields", "reconciliationChanges", "validationChecks", "gateChecks", "proposalChangedFiles",
  ];
  return hasExactKeys(value, new Set(keys), keys) && Object.values(value).every(isCount);
}

function isSafePartialCounts(value: Partial<RunReportCounts>): boolean {
  const allowed = new Set([
    "filesDiscovered", "filesEligible", "filesExcluded", "filesRejectedForSecurity", "observations",
    "evidenceItems", "profileFields", "reconciliationChanges", "validationChecks", "gateChecks", "proposalChangedFiles",
  ]);
  return Object.keys(value).every((key) => allowed.has(key)) && Object.values(value).every(isCount);
}