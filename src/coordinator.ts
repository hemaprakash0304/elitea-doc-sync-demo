import { randomUUID } from "node:crypto";
import {
  normalizeRepositoryIdentifier,
  type ExecutionContext,
  type RunConfiguration,
} from "./config.js";
import { createGitHubReadClient, type GitHubReadClient, type GitHubRepositoryMetadata } from "./github-client.js";
import { GitHubReadError, type GitHubReadErrorCode } from "./github-errors.js";
import { collectRepositorySnapshot, RepositoryCollectionError, TECHNICAL_PROFILE_PATH, type CollectionErrorCode } from "./collection.js";
import {
  filterRepositorySnapshot,
  UnavailableSecretScanner,
  type FilterBlockingReason,
  type RepositoryFilterResult,
  type SecretScanner,
} from "./filter.js";
import { DEFAULT_TECHNOLOGY_ANALYZERS, runTechnologyAnalyzers, type TechnologyAnalysisResult } from "./analyzers/index.js";
import { buildEvidenceCatalog, EvidenceCatalogError, type EvidenceCatalogErrorCode } from "./evidence/catalog.js";
import type { EvidenceCatalogResult } from "./evidence/types.js";
import { composeTechnicalProfile, ProfileComposerError, type ProfileCompositionResult, type ProfileComposerErrorCode } from "./composer.js";
import {
  reconcileTechnicalProfile,
  type ProfileReconciliationResult,
  type ReconciliationStatus,
} from "./reconciler.js";
import { validateReconciledCandidate, type ValidationResult, type ValidationStatus } from "./validation.js";
import {
  createAutomatedTestBinding,
  evaluateMandatoryGate,
  type AutomatedTestBinding,
  type AutomatedTestResult,
  type MandatoryGateResult,
  type ProposalAuthorization,
} from "./gate.js";
import {
  submitTechnicalProfileProposal,
  type ProposalResult,
  type ProposalWriteClient,
} from "./proposal.js";
import { createSanitizedRunReport, type SanitizedRunReport } from "./report.js";
import {
  OperationalTimeoutError,
  resolveOperationalLimits,
  tryAcquireProposalRunLock,
  type OperationalLimitOverrides,
} from "./operations.js";

export type RunStage = "CONFIGURED" | "READY_FOR_COLLECTION" | "COLLECTED" | "FILTERED" | "ANALYZED" | "EVIDENCED" | "COMPOSED" | "RECONCILED" | "VALIDATED" | "GATE_CHECKED" | "PROPOSED";
export type RunStatus = "configured" | "ready" | "partial" | "failed";

export interface RunContext {
  runId: string;
  workflowRunId?: string;
  targetRepository: string;
  normalizedRepositoryId: string;
  executionContext: ExecutionContext;
  startedAt: string;
  defaultBranch?: string;
  snapshotCommitSha?: string;
  stage: RunStage;
  status: RunStatus;
}

export interface ProposalCompletedDiagnostic {
  level: "info" | "error";
  event: "proposal_created" | "proposal_no_changes";
  runId: string;
  normalizedRepositoryId: string;
  repositoryId: number;
  defaultBranch: string;
  snapshotCommitSha: string;
  isPrivate: boolean;
  readRetryCount: number;
  profilePresent: boolean;
  includedFileCount: number;
  excludedFileCount: number;
  sensitiveFindingCount: number;
  scanner: RepositoryFilterResult["scan"]["scanner"];
  scanStatus: RepositoryFilterResult["scan"]["status"];
  scanCoverageComplete: boolean;
  profileSafety: RepositoryFilterResult["existingProfile"]["status"];
  executionContext: ExecutionContext;
  observationCount: number;
  analyzerIssueCount: number;
  evidenceCount: number;
  coverageEntryCount: number;
  conflictingEvidenceCount: number;
  catalogIssueCount: number;
  candidateSha256: string;
  schemaVersion: number;
  reconciliationStatus: ReconciliationStatus;
  additionCount: number;
  modificationCount: number;
  removalCount: number;
  conflictCount: number;
  preservedManualContent: boolean;
  validationStatus: ValidationStatus;
  validationCheckCount: number;
  blockingFailureCount: number;
  warningCount: number;
  gateStatus: "PASS";
  gateCheckCount: number;
  gateFailureCount: number;
  automatedTestStatus: AutomatedTestResult["status"];
  proposalStatus: "CREATED" | "NO_CHANGES";
  changedFileCount: number;
  branchName?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  fromStage: "GATE_CHECKED";
  toStage: "PROPOSED";
  status: RunStatus;
}

export type CoordinatorErrorCode = "INVALID_CONFIGURATION" | "RUN_INITIALIZATION_FAILED" | "BUSY" | "RECONCILIATION_BLOCKED" | "RECONCILIATION_FAILED" | "VALIDATION_BLOCKED" | "VALIDATION_FAILED" | "GATE_BLOCKED" | "PROPOSAL_BLOCKED" | "PROPOSAL_STALE" | "PROPOSAL_FAILED" | GitHubReadErrorCode | CollectionErrorCode | FilterBlockingReason | EvidenceCatalogErrorCode | ProfileComposerErrorCode;

export interface CoordinatorError {
  code: CoordinatorErrorCode;
  message: string;
  retryCount: number;
}

export interface CoordinatorFailureDiagnostic {
  level: "error";
  event: "run_initialization_failed" | "busy" | "run_timeout" | "filter_blocked" | "reconciliation_blocked" | "gate_blocked" | "proposal_blocked";
  code: CoordinatorErrorCode;
  message: string;
  retryCount: number;
  runId?: string;
  normalizedRepositoryId?: string;
}

export type CoordinatorExecutionResult =
  | { ok: true; context: RunContext; repository: GitHubRepositoryMetadata; filtered: RepositoryFilterResult; analysis: TechnologyAnalysisResult; evidenceCatalog: EvidenceCatalogResult; composition: ProfileCompositionResult; reconciliation: ProfileReconciliationResult; validation: ValidationResult; gate: MandatoryGateResult; proposalAuthorization: ProposalAuthorization; proposal: ProposalResult; diagnostic: ProposalCompletedDiagnostic }
  | { ok: false; error: CoordinatorError; diagnostic: CoordinatorFailureDiagnostic; context?: RunContext; filtered?: RepositoryFilterResult; reconciliation?: ProfileReconciliationResult; validation?: ValidationResult; gate?: MandatoryGateResult; proposal?: ProposalResult };

export type CoordinatorResult = CoordinatorExecutionResult & { report: SanitizedRunReport };

export interface CoordinatorDependencies {
  createRunId?: () => string;
  now?: () => Date;
  githubClient?: GitHubReadClient;
  createGitHubClient?: (executionContext: ExecutionContext) => GitHubReadClient;
  secretScanner?: SecretScanner;
  automatedTests?: AutomatedTestResult | ((binding: AutomatedTestBinding, signal: AbortSignal) => AutomatedTestResult | Promise<AutomatedTestResult>);
  automatedTestTimeoutMs?: number;
  proposalWriteClient?: ProposalWriteClient;
  operationalLimits?: OperationalLimitOverrides;
}

const ALLOWED_CONFIGURATION_KEYS = new Set([
  "targetRepository",
  "normalizedRepositoryId",
  "executionContext",
  "runId",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_CONFIGURATION_MESSAGE = "Run configuration is invalid.";
const INITIALIZATION_FAILURE_MESSAGE = "Run initialization could not be completed safely.";

export async function coordinateRun(
  configuration: unknown,
  dependencies: CoordinatorDependencies = {},
): Promise<CoordinatorResult> {
  const operationalLimits = resolveOperationalLimits(dependencies.operationalLimits);
  let releaseProposalRun: (() => void) | undefined;
  if (dependencies.proposalWriteClient !== undefined && isRunConfiguration(configuration)) {
    releaseProposalRun = tryAcquireProposalRunLock(configuration.normalizedRepositoryId);
    if (releaseProposalRun === undefined) {
      const runId = `run-${randomUUID()}`;
      const now = dependencies.now ?? (() => new Date());
      const candidateStart = now();
      const startedAt = candidateStart instanceof Date && Number.isFinite(candidateStart.getTime()) ? candidateStart : new Date();
      const message = "A proposal-capable run is already active for this repository.";
      const result: CoordinatorExecutionResult = {
        ok: false,
        error: { code: "BUSY", message, retryCount: 0 },
        diagnostic: {
          level: "error",
          event: "busy",
          code: "BUSY",
          message,
          retryCount: 0,
          runId,
          normalizedRepositoryId: configuration.normalizedRepositoryId,
        },
        context: createRunContext(configuration, runId, startedAt, "CONFIGURED", "failed"),
      };
      return { ...result, report: createSanitizedRunReport(result, completionTimestamp(dependencies)) };
    }
  }
  try {
    const result = await executeCoordinatorRun(configuration, dependencies, operationalLimits);
    return { ...result, report: createSanitizedRunReport(result, completionTimestamp(dependencies)) };
  } finally {
    releaseProposalRun?.();
  }
}

async function executeCoordinatorRun(
  configuration: unknown,
  dependencies: CoordinatorDependencies,
  operationalLimits: ReturnType<typeof resolveOperationalLimits>,
): Promise<CoordinatorExecutionResult> {
  if (!isRunConfiguration(configuration)) {
    return createFailure("INVALID_CONFIGURATION", INVALID_CONFIGURATION_MESSAGE);
  }

  let runId: string;
  let startedAt: Date;
  try {
    const uuid = (dependencies.createRunId ?? randomUUID)();
    startedAt = (dependencies.now ?? (() => new Date()))();
    if (!UUID_PATTERN.test(uuid) || Number.isNaN(startedAt.getTime())) {
      return createFailure("RUN_INITIALIZATION_FAILED", INITIALIZATION_FAILURE_MESSAGE);
    }

    runId = `run-${uuid}`;
  } catch {
    return createFailure("RUN_INITIALIZATION_FAILED", INITIALIZATION_FAILURE_MESSAGE);
  }

  const configuredContext = createRunContext(configuration, runId, startedAt, "CONFIGURED", "configured");
  const readyContext = createRunContext(configuration, runId, startedAt, "READY_FOR_COLLECTION", "ready");
  const deadlineAtMs = Date.now() + operationalLimits.overallRunTimeoutMs;
  let stageContext = readyContext;
  try {
    assertRunDeadline(deadlineAtMs, "COLLECTION");
    const client = dependencies.githubClient ??
      (dependencies.createGitHubClient ?? createGitHubReadClient)(configuration.executionContext);
    const repository = await client.getRepositoryMetadata(configuration);
    const collection = await collectRepositorySnapshot(configuration, repository, client, { deadlineAtMs });
    assertRunDeadline(deadlineAtMs, "COLLECTION");
    const collectedContext = createRunContext(configuration, runId, startedAt, "COLLECTED", "ready", {
      defaultBranch: collection.defaultBranch,
      snapshotCommitSha: collection.snapshotCommitSha,
    });
    stageContext = collectedContext;
    assertRunDeadline(deadlineAtMs, "FILTERING");
    const filterTimeoutMs = Math.min(operationalLimits.scannerTimeoutMs, deadlineAtMs - Date.now());
    const filtered = await filterRepositorySnapshot(
      collection,
      dependencies.secretScanner ?? new UnavailableSecretScanner(),
      { scannerTimeoutMs: filterTimeoutMs },
    );
    assertRunDeadline(deadlineAtMs, "FILTERING");
    const isPartial = filtered.status === "partial" || collection.status === "partial";
    const context: RunContext = {
      ...collectedContext,
      stage: "FILTERED",
      status: isPartial ? "partial" : "ready",
    };
    stageContext = context;
    if (filtered.status === "blocked") {
      const code = filtered.blockingReason ?? "SCANNER_FAILED";
      const message = filterFailureMessage(code);
      return {
        ok: false,
        error: { code, message, retryCount: 0 },
        diagnostic: {
          level: "error",
          event: "filter_blocked",
          code,
          message,
          retryCount: 0,
          runId,
          normalizedRepositoryId: repository.normalizedRepositoryId,
        },
        context: { ...context, status: "failed" },
        filtered,
      };
    }

    const analysis = runTechnologyAnalyzers(filtered, DEFAULT_TECHNOLOGY_ANALYZERS);
    assertRunDeadline(deadlineAtMs, "ANALYSIS");
    const evidenceCatalog = buildEvidenceCatalog(filtered, analysis, { repositoryFullName: repository.fullName });
    assertRunDeadline(deadlineAtMs, "EVIDENCE");
    const composition = composeTechnicalProfile(evidenceCatalog);
    assertRunDeadline(deadlineAtMs, "COMPOSITION");
    const reconciliation = reconcileTechnicalProfile(filtered, collection.existingProfile, evidenceCatalog, composition);
    assertRunDeadline(deadlineAtMs, "RECONCILIATION");
    if (reconciliation.status === "BLOCKED" || reconciliation.status === "FAILED") {
      const blocked = reconciliation.status === "BLOCKED";
      const code = blocked ? "RECONCILIATION_BLOCKED" : "RECONCILIATION_FAILED";
      const message = blocked
        ? "Existing profile ownership or security could not be established; approved content was preserved."
        : "Profile reconciliation could not be completed safely; approved content was preserved.";
      return {
        ok: false,
        error: { code, message, retryCount: 0 },
        diagnostic: {
          level: "error",
          event: "reconciliation_blocked",
          code,
          message,
          retryCount: 0,
          runId,
          normalizedRepositoryId: configuration.normalizedRepositoryId,
        },
        context: { ...context, stage: "RECONCILED", status: "failed" },
        filtered,
        reconciliation,
      };
    }
    stageContext = { ...context, stage: "RECONCILED" };
    assertRunDeadline(deadlineAtMs, "VALIDATION");
    const validationScannerTimeoutMs = Math.min(operationalLimits.scannerTimeoutMs, deadlineAtMs - Date.now());
    const validation = await validateReconciledCandidate({
      filtered,
      catalog: evidenceCatalog,
      composition,
      reconciliation,
      scanner: dependencies.secretScanner ?? new UnavailableSecretScanner(),
      scannerTimeoutMs: validationScannerTimeoutMs,
    });
    const testBinding = createAutomatedTestBinding({
      runId,
      configuration,
      filtered,
      composition,
      reconciliation,
    });
    assertRunDeadline(deadlineAtMs, "VALIDATION");
    stageContext = { ...context, stage: "VALIDATED" };
    assertRunDeadline(deadlineAtMs, "GATE");
    const remainingTestTimeoutMs = Math.max(1, deadlineAtMs - Date.now());
    const automatedTests = await resolveAutomatedTests(
      dependencies,
      testBinding,
      Math.min(operationalLimits.overallRunTimeoutMs, remainingTestTimeoutMs),
    );
    assertRunDeadline(deadlineAtMs, "GATE");
    const gate = evaluateMandatoryGate({
      runId,
      configuration,
      repository,
      filtered,
      catalog: evidenceCatalog,
      composition,
      reconciliation,
      validation,
      ...(automatedTests === undefined ? {} : { automatedTests }),
      ...(dependencies.secretScanner?.version === undefined ? {} : { scannerVersion: dependencies.secretScanner.version }),
      changedFilePaths: reconciliation.status === "NO_CHANGES" ? [] : [TECHNICAL_PROFILE_PATH],
    });
    stageContext = { ...context, stage: "GATE_CHECKED" };
    if (gate.status !== "PASS" || gate.proposalAuthorization === undefined) {
      const message = "Mandatory validation, security, and automated-test checks did not all pass; no proposal capability was authorized.";
      return {
        ok: false,
        error: { code: "GATE_BLOCKED", message, retryCount: 0 },
        diagnostic: {
          level: "error",
          event: "gate_blocked",
          code: "GATE_BLOCKED",
          message,
          retryCount: 0,
          runId,
          normalizedRepositoryId: configuration.normalizedRepositoryId,
        },
        context: { ...stageContext, status: "failed" },
        filtered,
        validation,
        gate,
      };
    }
    assertRunDeadline(deadlineAtMs, "PROPOSAL");
    const proposal = await submitTechnicalProfileProposal({
      runId,
      configuration,
      repository,
      filtered,
      snapshot: { branch: collection.defaultBranch, commitSha: collection.snapshotCommitSha, treeSha: collection.snapshotTreeSha, readRetryCount: collection.readRetryCount },
      composition,
      reconciliation,
      gate,
      authorization: gate.proposalAuthorization,
      ...(dependencies.secretScanner?.version === undefined ? {} : { scannerVersion: dependencies.secretScanner.version }),
      proposalOperationTimeoutMs: Math.min(operationalLimits.proposalOperationTimeoutMs, Math.max(1, deadlineAtMs - Date.now())),
      deadlineAtMs,
      readClient: client,
      ...(dependencies.proposalWriteClient === undefined ? {} : { writeClient: dependencies.proposalWriteClient }),
    });
    assertRunDeadline(deadlineAtMs, "PROPOSAL");
    if (proposal.status !== "CREATED" && proposal.status !== "NO_CHANGES") {
      const stale = proposal.status === "STALE";
      const code = stale ? "PROPOSAL_STALE" : proposal.status === "BLOCKED" ? "PROPOSAL_BLOCKED" : "PROPOSAL_FAILED";
      const message = stale
        ? "The default branch changed after validation; no proposal was made. Rerun the complete pipeline on the latest snapshot."
        : proposal.status === "BLOCKED"
          ? "Proposal capability or authorization was unavailable or invalid; no branch or pull request was created."
          : "Proposal creation failed safely; the approved default branch was not changed.";
      return {
        ok: false,
        error: { code, message, retryCount: 0 },
        diagnostic: {
          level: "error",
          event: "proposal_blocked",
          code,
          message,
          retryCount: 0,
          runId,
          normalizedRepositoryId: configuration.normalizedRepositoryId,
        },
        context: { ...context, stage: "GATE_CHECKED", status: "failed" },
        filtered,
        validation,
        gate,
        proposal,
      };
    }
    const hasPartialEvidence = collection.status === "partial" || filtered.status === "partial" ||
      analysis.issues.length > 0 || evidenceCatalog.issues.length > 0;
    const evidencedContext: RunContext = {
      ...context,
      stage: "PROPOSED",
      status: hasPartialEvidence ? "partial" : context.status,
    };

    return {
      ok: true,
      context: evidencedContext,
      repository,
      filtered,
      analysis,
      evidenceCatalog,
      composition,
      reconciliation,
      validation,
      gate,
      proposalAuthorization: gate.proposalAuthorization,
      proposal,
      diagnostic: {
        level: "info",
        event: proposal.status === "CREATED" ? "proposal_created" : "proposal_no_changes",
        runId,
        normalizedRepositoryId: repository.normalizedRepositoryId,
        repositoryId: repository.repositoryId,
        defaultBranch: repository.defaultBranch,
        snapshotCommitSha: collection.snapshotCommitSha,
        isPrivate: repository.isPrivate,
        readRetryCount: collection.readRetryCount,
        profilePresent: collection.existingProfile.profilePresent,
        includedFileCount: filtered.analysisFiles.length,
        excludedFileCount: filtered.exclusionRecords.length,
        sensitiveFindingCount: filtered.securityFindings.length,
        scanner: filtered.scan.scanner,
        scanStatus: filtered.scan.status,
        scanCoverageComplete: filtered.scan.coverageComplete,
        profileSafety: filtered.existingProfile.status,
        observationCount: analysis.observations.length,
        analyzerIssueCount: analysis.issues.length,
        evidenceCount: evidenceCatalog.evidence.length,
        coverageEntryCount: evidenceCatalog.coverage.length,
        conflictingEvidenceCount: evidenceCatalog.evidence.filter((item) => item.status === "Conflict").length,
        catalogIssueCount: evidenceCatalog.issues.length,
        candidateSha256: composition.candidateSha256,
        schemaVersion: composition.schemaVersion,
        reconciliationStatus: reconciliation.status,
        additionCount: reconciliation.additions.length,
        modificationCount: reconciliation.modifications.length,
        removalCount: reconciliation.removals.length,
        conflictCount: reconciliation.conflicts.length,
        preservedManualContent: reconciliation.preservedManualContent,
        validationStatus: validation.status,
        validationCheckCount: validation.checks.length,
        blockingFailureCount: validation.blockingFailures.length,
        warningCount: validation.warnings.length,
        gateStatus: gate.status,
        gateCheckCount: gate.checks.length,
        gateFailureCount: gate.blockingFailures.length,
        automatedTestStatus: gate.automatedTestResult.status === "MISSING" ? "UNAVAILABLE" : gate.automatedTestResult.status,
        proposalStatus: proposal.status,
        changedFileCount: proposal.changedFiles.length,
        ...(proposal.branchName === undefined ? {} : { branchName: proposal.branchName }),
        ...(proposal.pullRequest === undefined ? {} : { pullRequestNumber: proposal.pullRequest.number, pullRequestUrl: proposal.pullRequest.url }),
        executionContext: evidencedContext.executionContext,
        fromStage: "GATE_CHECKED",
        toStage: "PROPOSED",
        status: evidencedContext.status,
      },
    };
  } catch (error) {
    if (error instanceof OperationalTimeoutError ||
      (error instanceof RepositoryCollectionError && error.code === "RUN_TIMEOUT")) {
      const message = "The run exceeded its configured execution deadline; no further stage was started.";
      return {
        ok: false,
        error: { code: "RUN_TIMEOUT", message, retryCount: 0 },
        diagnostic: {
          level: "error",
          event: "run_timeout",
          code: "RUN_TIMEOUT",
          message,
          retryCount: 0,
          runId,
          normalizedRepositoryId: configuration.normalizedRepositoryId,
        },
        context: { ...stageContext, status: "failed" },
      };
    }
    if (error instanceof EvidenceCatalogError) {
      const code = error.code;
      const failure = createFailure(code, error.message, 0, runId, configuration.normalizedRepositoryId);
      return { ...failure, context: { ...readyContext, stage: "ANALYZED", status: "failed" } };
    }
    if (error instanceof ProfileComposerError) {
      const failure = createFailure(error.code, error.message, 0, runId, configuration.normalizedRepositoryId);
      return { ...failure, context: { ...readyContext, stage: "EVIDENCED", status: "failed" } };
    }
    const failure = error instanceof RepositoryCollectionError
      ? createFailure(error.code, error.message, error.retryCount, runId, configuration.normalizedRepositoryId)
      : error instanceof GitHubReadError
        ? createFailure(error.code, error.message, error.retryCount, runId, configuration.normalizedRepositoryId)
        : createFailure("RUN_INITIALIZATION_FAILED", INITIALIZATION_FAILURE_MESSAGE, 0, runId, configuration.normalizedRepositoryId);
    const context = error instanceof RepositoryCollectionError || error instanceof GitHubReadError
      ? readyContext
      : configuredContext;
    return { ...failure, context: { ...context, status: "failed" } };
  }
}

function completionTimestamp(dependencies: CoordinatorDependencies): string | undefined {
  try {
    const value = (dependencies.now ?? (() => new Date()))();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

const AUTOMATED_TEST_TIMEOUT = Symbol("automated-test-timeout");

async function resolveAutomatedTests(
  dependencies: CoordinatorDependencies,
  binding: AutomatedTestBinding,
  maximumTimeoutMs: number,
): Promise<AutomatedTestResult | undefined> {
  const result = dependencies.automatedTests;
  if (result === undefined || typeof result !== "function") {
    return result;
  }
  const configuredTimeoutMs = dependencies.automatedTestTimeoutMs ?? maximumTimeoutMs;
  const timeoutMs = Math.min(configuredTimeoutMs, maximumTimeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return { status: "INDETERMINATE", binding };
  }

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AutomatedTestResult>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(AUTOMATED_TEST_TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => result(binding, controller.signal)),
      timeout,
    ]);
  } catch (error) {
    return { status: error === AUTOMATED_TEST_TIMEOUT ? "TIMEOUT" : "INDETERMINATE", binding };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function filterFailureMessage(code: FilterBlockingReason): string {
  switch (code) {
    case "SCANNER_UNAVAILABLE":
      return "The required local secret scanner is unavailable; analysis was blocked.";
    case "SCANNER_FAILED":
      return "The local secret scan failed; analysis was blocked.";
    case "SCANNER_TIMEOUT":
      return "The local secret scan timed out; analysis was blocked.";
    case "SCAN_INCOMPLETE":
      return "The local secret scan did not cover all eligible input; analysis was blocked.";
    case "INVALID_SCAN_RESULT":
      return "The local secret scanner returned an invalid result; analysis was blocked.";
    case "SCANNER_BOUNDARY_INVALID":
      return "The secret scanner is outside the approved local processing boundary; analysis was blocked.";
    case "EXISTING_PROFILE_SECRET":
      return "The existing technical profile contains a sensitive finding; analysis was blocked.";
    case "EXISTING_PROFILE_UNAVAILABLE":
      return "The existing technical profile could not be scanned safely; analysis was blocked.";
    case "COLLECTION_INCOMPLETE":
      return "Eligible repository content was omitted or unreadable; analysis was blocked.";
  }
}

function isRunConfiguration(value: unknown): value is RunConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const configuration = value as Record<string, unknown>;
  if (Object.keys(configuration).some((key) => !ALLOWED_CONFIGURATION_KEYS.has(key))) {
    return false;
  }

  if (
    typeof configuration.targetRepository !== "string" ||
    typeof configuration.normalizedRepositoryId !== "string" ||
    (configuration.executionContext !== "local" && configuration.executionContext !== "actions")
  ) {
    return false;
  }

  if (configuration.runId !== undefined && (typeof configuration.runId !== "string" || !/^\d+$/.test(configuration.runId))) {
    return false;
  }

  try {
    return normalizeRepositoryIdentifier(configuration.targetRepository) === configuration.normalizedRepositoryId;
  } catch {
    return false;
  }
}

function createRunContext(
  configuration: RunConfiguration,
  runId: string,
  startedAt: Date,
  stage: RunStage,
  status: RunStatus,
  snapshot?: { defaultBranch: string; snapshotCommitSha: string },
): RunContext {
  return {
    runId,
    targetRepository: configuration.targetRepository,
    normalizedRepositoryId: configuration.normalizedRepositoryId,
    executionContext: configuration.executionContext,
    startedAt: startedAt.toISOString(),
    ...(snapshot === undefined ? {} : snapshot),
    stage,
    status,
    ...(configuration.runId === undefined ? {} : { workflowRunId: configuration.runId }),
  };
}

function createFailure(
  code: CoordinatorErrorCode,
  message: string,
  retryCount = 0,
  runId?: string,
  normalizedRepositoryId?: string,
): CoordinatorExecutionResult {
  return {
    ok: false,
    error: { code, message, retryCount },
    diagnostic: {
      level: "error",
      event: "run_initialization_failed",
      code,
      message,
      retryCount,
      ...(runId === undefined ? {} : { runId }),
      ...(normalizedRepositoryId === undefined ? {} : { normalizedRepositoryId }),
    },
  };
}

function assertRunDeadline(deadlineAtMs: number, stage: string): void {
  if (Date.now() >= deadlineAtMs) {
    throw new OperationalTimeoutError(stage);
  }
}