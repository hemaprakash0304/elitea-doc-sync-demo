import { randomUUID } from "node:crypto";
import {
  normalizeRepositoryIdentifier,
  type ExecutionContext,
  type RunConfiguration,
} from "./config.js";
import { createGitHubReadClient, type GitHubReadClient, type GitHubRepositoryMetadata } from "./github-client.js";
import { GitHubReadError, type GitHubReadErrorCode } from "./github-errors.js";
import { collectRepositorySnapshot, RepositoryCollectionError, type CollectionErrorCode } from "./collection.js";
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

export type RunStage = "CONFIGURED" | "READY_FOR_COLLECTION" | "COLLECTED" | "FILTERED" | "ANALYZED" | "EVIDENCED" | "COMPOSED" | "RECONCILED";
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

export interface ReconciliationCompletedDiagnostic {
  level: "info" | "error";
  event: "reconciliation_completed" | "reconciliation_blocked";
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
  fromStage: "COMPOSED";
  toStage: "RECONCILED";
  status: RunStatus;
}

export type CoordinatorErrorCode = "INVALID_CONFIGURATION" | "RUN_INITIALIZATION_FAILED" | "RECONCILIATION_BLOCKED" | "RECONCILIATION_FAILED" | GitHubReadErrorCode | CollectionErrorCode | FilterBlockingReason | EvidenceCatalogErrorCode | ProfileComposerErrorCode;

export interface CoordinatorError {
  code: CoordinatorErrorCode;
  message: string;
  retryCount: number;
}

export interface CoordinatorFailureDiagnostic {
  level: "error";
  event: "run_initialization_failed" | "filter_blocked" | "reconciliation_blocked";
  code: CoordinatorErrorCode;
  message: string;
  retryCount: number;
  runId?: string;
  normalizedRepositoryId?: string;
}

export type CoordinatorResult =
  | { ok: true; context: RunContext; repository: GitHubRepositoryMetadata; filtered: RepositoryFilterResult; analysis: TechnologyAnalysisResult; evidenceCatalog: EvidenceCatalogResult; composition: ProfileCompositionResult; reconciliation: ProfileReconciliationResult; diagnostic: ReconciliationCompletedDiagnostic }
  | { ok: false; error: CoordinatorError; diagnostic: CoordinatorFailureDiagnostic; context?: RunContext; filtered?: RepositoryFilterResult; reconciliation?: ProfileReconciliationResult };

export interface CoordinatorDependencies {
  createRunId?: () => string;
  now?: () => Date;
  githubClient?: GitHubReadClient;
  createGitHubClient?: (executionContext: ExecutionContext) => GitHubReadClient;
  secretScanner?: SecretScanner;
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
  try {
    const client = dependencies.githubClient ??
      (dependencies.createGitHubClient ?? createGitHubReadClient)(configuration.executionContext);
    const repository = await client.getRepositoryMetadata(configuration);
    const collection = await collectRepositorySnapshot(configuration, repository, client);
    const collectedContext = createRunContext(configuration, runId, startedAt, "COLLECTED", "ready", {
      defaultBranch: collection.defaultBranch,
      snapshotCommitSha: collection.snapshotCommitSha,
    });
    const filtered = await filterRepositorySnapshot(collection, dependencies.secretScanner ?? new UnavailableSecretScanner());
    const isPartial = filtered.status === "partial" || collection.status === "partial";
    const context: RunContext = {
      ...collectedContext,
      stage: "FILTERED",
      status: isPartial ? "partial" : "ready",
    };
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
    const evidenceCatalog = buildEvidenceCatalog(filtered, analysis, { repositoryFullName: repository.fullName });
    const composition = composeTechnicalProfile(evidenceCatalog);
    const reconciliation = reconcileTechnicalProfile(filtered, collection.existingProfile, evidenceCatalog, composition);
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
    const hasPartialEvidence = collection.status === "partial" || filtered.status === "partial" ||
      analysis.issues.length > 0 || evidenceCatalog.issues.length > 0;
    const evidencedContext: RunContext = {
      ...context,
      stage: "RECONCILED",
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
      diagnostic: {
        level: "info",
        event: "reconciliation_completed",
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
        executionContext: evidencedContext.executionContext,
        fromStage: "COMPOSED",
        toStage: "RECONCILED",
        status: evidencedContext.status,
      },
    };
  } catch (error) {
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

function filterFailureMessage(code: FilterBlockingReason): string {
  switch (code) {
    case "SCANNER_UNAVAILABLE":
      return "The required local secret scanner is unavailable; analysis was blocked.";
    case "SCANNER_FAILED":
      return "The local secret scan failed; analysis was blocked.";
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
): CoordinatorResult {
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