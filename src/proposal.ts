import { createHash } from "node:crypto";
import { normalizeRepositoryIdentifier, type RunConfiguration } from "./config.js";
import { TECHNICAL_PROFILE_PATH } from "./collection.js";
import type { GitHubCommitSnapshot, GitHubReadClient, GitHubRepositoryMetadata } from "./github-client.js";
import type { ProfileCompositionResult } from "./composer.js";
import type { RepositoryFilterResult } from "./filter.js";
import type { ProfileReconciliationResult } from "./reconciler.js";
import { OperationalTimeoutError, resolveOperationalLimits, withFiniteTimeout } from "./operations.js";
import {
  AUTOMATED_TEST_SUITE_VERSION,
  isGatePassBoundTo,
  MANDATORY_GATE_VERSION,
  VALIDATOR_VERSION,
  type MandatoryGateResult,
  type ProposalAuthorization,
} from "./gate.js";

export type ProposalStatus = "CREATED" | "NO_CHANGES" | "BLOCKED" | "STALE" | "FAILED";

export type ProposalFailureCode =
  | "GATE_NOT_PASSED"
  | "AUTHORIZATION_MISSING"
  | "AUTHORIZATION_INVALID"
  | "TARGET_BINDING_MISMATCH"
  | "SNAPSHOT_BINDING_MISMATCH"
  | "CANDIDATE_DIGEST_MISMATCH"
  | "SCHEMA_UNSUPPORTED"
  | "ARTIFACT_PATH_INVALID"
  | "PROPOSAL_CAPABILITY_UNAVAILABLE"
  | "PROPOSAL_CAPABILITY_SCOPE_MISMATCH"
  | "PROPOSAL_CAPABILITY_UNSAFE"
  | "STALE_SNAPSHOT"
  | "BRANCH_COLLISION"
  | "BRANCH_CREATE_FAILED"
  | "COMMIT_FAILED"
  | "ARTIFACT_BOUNDARY_VIOLATION"
  | "BRANCH_VERIFY_FAILED"
  | "PULL_REQUEST_FAILED"
  | "PULL_REQUEST_RESPONSE_INVALID"
  | "PROPOSAL_TIMED_OUT"
  | "OPEN_PROPOSAL_EXISTS"
  | "OPEN_PROPOSAL_CONFLICT"
  | "OPEN_PROPOSAL_STATE_UNVERIFIED"
  | "STALE_PULL_REQUEST_CLOSED"
  | "STALE_PULL_REQUEST_CLOSE_FAILED";

export interface ProposalWriteCapability {
  provider: "dedicated_github_proposal_app";
  normalizedRepositoryId: string;
  repositoryId: number;
  permissions: {
    contents: "write";
    pullRequests: "write";
    canApprove: false;
    canMerge: false;
    canBypassBranchProtection: false;
    canWriteDefaultBranch: false;
  };
  branchProtection: {
    pullRequestRequired: true;
    humanApprovalRequired: true;
    proposalAppBypass: false;
  };
}

export interface ProposalBranchResult {
  status: "CREATED" | "ALREADY_EXISTS";
  branchName: string;
  baseCommitSha: string;
  failureCode?: "BRANCH_COLLISION" | "OPEN_PROPOSAL_EXISTS" | "OPEN_PROPOSAL_CONFLICT" | "OPEN_PROPOSAL_STATE_UNVERIFIED";
}

export interface ProposalCommitResult {
  commitSha: string;
  parentCommitSha: string;
  treeSha: string;
  changedPaths: string[];
  profileSha256: string;
}

export interface ProposalPullRequestResult {
  number: number;
  url: string;
  state: "open";
  headBranch: string;
  baseBranch: string;
}

export interface ProposalWriteClient {
  readonly capability: ProposalWriteCapability;
  createFeatureBranch(input: {
    repositoryId: number;
    repositoryFullName: string;
    branchName: string;
    baseBranch: string;
    baseCommitSha: string;
    candidateSha256: string;
    signal: AbortSignal;
  }): Promise<ProposalBranchResult>;
  commitSingleProfileFile(input: {
    repositoryId: number;
    repositoryFullName: string;
    branchName: string;
    baseCommitSha: string;
    baseTreeSha: string;
    path: typeof TECHNICAL_PROFILE_PATH;
    content: string;
    commitMessage: "docs: update technical profile";
    signal: AbortSignal;
  }): Promise<ProposalCommitResult>;
  getBranchHead(input: {
    repositoryId: number;
    repositoryFullName: string;
    branchName: string;
    signal: AbortSignal;
  }): Promise<{ branchName: string; commitSha: string }>;
  createPullRequest(input: {
    repositoryId: number;
    repositoryFullName: string;
    headBranch: string;
    baseBranch: string;
    title: "docs: update technical profile";
    body: string;
    signal: AbortSignal;
  }): Promise<ProposalPullRequestResult>;
  closePullRequest(input: {
    repositoryId: number;
    repositoryFullName: string;
    pullRequestNumber: number;
    signal: AbortSignal;
  }): Promise<boolean>;
}

export type ProposalWriteClientFactory = (
  configuration: RunConfiguration,
  repository: GitHubRepositoryMetadata,
) => ProposalWriteClient | undefined;

export interface ProposalInput {
  runId: string;
  configuration: RunConfiguration;
  repository: GitHubRepositoryMetadata;
  filtered: RepositoryFilterResult;
  snapshot: GitHubCommitSnapshot;
  composition: ProfileCompositionResult;
  reconciliation: ProfileReconciliationResult;
  gate: MandatoryGateResult;
  authorization?: ProposalAuthorization;
  scannerVersion?: string;
  proposalOperationTimeoutMs?: number;
  deadlineAtMs?: number;
  readClient: GitHubReadClient;
  writeClient?: ProposalWriteClient;
}

export interface ProposalResult {
  status: ProposalStatus;
  targetRepository: string;
  snapshotCommitSha: string;
  candidateSha256: string;
  allowedArtifactPath: typeof TECHNICAL_PROFILE_PATH;
  changedFiles: string[];
  branchName?: string;
  commitSha?: string;
  pullRequest?: { number: number; url: string };
  failureCode?: ProposalFailureCode;
}

export async function submitTechnicalProfileProposal(input: ProposalInput): Promise<ProposalResult> {
  const candidate = input.reconciliation.candidate;
  const candidateSha256 = candidate === undefined ? "" : sha256(candidate);
  const base: Pick<ProposalResult, "targetRepository" | "snapshotCommitSha" | "candidateSha256" | "allowedArtifactPath"> = {
    targetRepository: input.configuration.normalizedRepositoryId.toLowerCase(),
    snapshotCommitSha: input.filtered.snapshotCommitSha.toLowerCase(),
    candidateSha256,
    allowedArtifactPath: TECHNICAL_PROFILE_PATH,
  };

  const authorizationFailure = validateAuthorization(input, candidateSha256);
  if (authorizationFailure !== undefined) {
    return blocked(base, authorizationFailure);
  }

  if (input.reconciliation.status === "NO_CHANGES") {
    return { ...base, status: "NO_CHANGES", changedFiles: [] };
  }

  const writer = input.writeClient;
  if (writer === undefined) {
    return blocked(base, "PROPOSAL_CAPABILITY_UNAVAILABLE");
  }
  let scopeFailure: ProposalFailureCode | undefined;
  try {
    scopeFailure = validateWriteCapability(writer.capability, input);
  } catch {
    scopeFailure = "PROPOSAL_CAPABILITY_UNSAFE";
  }
  if (scopeFailure !== undefined) {
    return blocked(base, scopeFailure);
  }

  const current = await readCurrentDefaultBranch(input);
  if (current.status !== "CURRENT") {
    return current.status === "STALE"
      ? { ...base, status: "STALE", changedFiles: [], failureCode: "STALE_SNAPSHOT" }
      : blocked(base, current.code);
  }

  const branchName = proposalBranchName(input.runId, candidateSha256);
  let branch: ProposalBranchResult;
  try {
    branch = await withProposalTimeout(input, "PROPOSAL_BRANCH", (signal) => writer.createFeatureBranch({
      repositoryId: input.repository.repositoryId,
      repositoryFullName: input.repository.fullName,
      branchName,
      baseBranch: input.repository.defaultBranch,
      baseCommitSha: input.snapshot.commitSha,
      candidateSha256,
      signal,
    }));
  } catch (error) {
    return { ...base, status: "FAILED", changedFiles: [], failureCode: proposalFailureFromError(error, "BRANCH_CREATE_FAILED") };
  }
  if (branch === null || typeof branch !== "object") {
    return { ...base, status: "FAILED", changedFiles: [], branchName, failureCode: "BRANCH_CREATE_FAILED" };
  }
  if (branch.status === "ALREADY_EXISTS") {
    const failureCode = branch.failureCode ?? "BRANCH_COLLISION";
    return {
      ...base,
      status: failureCode === "BRANCH_COLLISION" ? "FAILED" : "BLOCKED",
      changedFiles: [],
      branchName,
      failureCode,
    };
  }
  if (branch.branchName !== branchName || branch.baseCommitSha.toLowerCase() !== input.snapshot.commitSha.toLowerCase()) {
    return { ...base, status: "FAILED", changedFiles: [], branchName, failureCode: "BRANCH_CREATE_FAILED" };
  }

  let commit: ProposalCommitResult;
  try {
    commit = await withProposalTimeout(input, "PROPOSAL_COMMIT", (signal) => writer.commitSingleProfileFile({
      repositoryId: input.repository.repositoryId,
      repositoryFullName: input.repository.fullName,
      branchName,
      baseCommitSha: input.snapshot.commitSha,
      baseTreeSha: input.snapshot.treeSha,
      path: TECHNICAL_PROFILE_PATH,
      content: candidate as string,
      commitMessage: "docs: update technical profile",
      signal,
    }));
  } catch (error) {
    return { ...base, status: "FAILED", changedFiles: [], branchName, failureCode: proposalFailureFromError(error, "COMMIT_FAILED") };
  }
  if (commit === null || typeof commit !== "object" || !validCommitResult(commit, input, candidateSha256)) {
    return {
      ...base,
      status: "FAILED",
      changedFiles: sanitizeChangedPaths(Array.isArray(commit.changedPaths) ? commit.changedPaths : []),
      branchName,
      ...(isGitSha(commit.commitSha) ? { commitSha: commit.commitSha.toLowerCase() } : {}),
      failureCode: "ARTIFACT_BOUNDARY_VIOLATION",
    };
  }

  let branchHead: { branchName: string; commitSha: string };
  try {
    branchHead = await withProposalTimeout(input, "PROPOSAL_BRANCH_VERIFY", (signal) => writer.getBranchHead({
      repositoryId: input.repository.repositoryId,
      repositoryFullName: input.repository.fullName,
      branchName,
      signal,
    }));
  } catch (error) {
    return { ...base, status: "FAILED", changedFiles: [TECHNICAL_PROFILE_PATH], branchName, commitSha: commit.commitSha, failureCode: proposalFailureFromError(error, "BRANCH_VERIFY_FAILED") };
  }
  if (
    branchHead === null || typeof branchHead !== "object" ||
    branchHead.branchName !== branchName || branchHead.commitSha.toLowerCase() !== commit.commitSha.toLowerCase()
  ) {
    return { ...base, status: "FAILED", changedFiles: [TECHNICAL_PROFILE_PATH], branchName, commitSha: commit.commitSha, failureCode: "BRANCH_VERIFY_FAILED" };
  }

  const beforePullRequest = await readCurrentDefaultBranch(input);
  if (beforePullRequest.status !== "CURRENT") {
    return {
      ...base,
      status: beforePullRequest.status === "STALE" ? "STALE" : "FAILED",
      changedFiles: [TECHNICAL_PROFILE_PATH],
      branchName,
      commitSha: commit.commitSha,
      failureCode: beforePullRequest.status === "STALE" ? "STALE_SNAPSHOT" : beforePullRequest.code,
    };
  }

  let pullRequest: ProposalPullRequestResult;
  try {
    pullRequest = await withProposalTimeout(input, "PROPOSAL_PULL_REQUEST", (signal) => writer.createPullRequest({
      repositoryId: input.repository.repositoryId,
      repositoryFullName: input.repository.fullName,
      headBranch: branchName,
      baseBranch: input.repository.defaultBranch,
      title: "docs: update technical profile",
      body: pullRequestBody(input, candidateSha256),
      signal,
    }));
  } catch (error) {
    return { ...base, status: "FAILED", changedFiles: [TECHNICAL_PROFILE_PATH], branchName, commitSha: commit.commitSha, failureCode: proposalFailureFromError(error, "PULL_REQUEST_FAILED") };
  }
  if (
    pullRequest === null || typeof pullRequest !== "object" ||
    !validPullRequest(pullRequest, branchName, input.repository.defaultBranch, input.repository.fullName)
  ) {
    if (isClosableProposalPullRequest(pullRequest, branchName, input.repository.fullName)) {
      try {
        await withProposalTimeout(input, "PROPOSAL_CLOSE", (signal) => writer.closePullRequest({
          repositoryId: input.repository.repositoryId,
          repositoryFullName: input.repository.fullName,
          pullRequestNumber: pullRequest.number,
          signal,
        }));
      } catch {
      }
    }
    return {
      ...base,
      status: "FAILED",
      changedFiles: [TECHNICAL_PROFILE_PATH],
      branchName,
      commitSha: commit.commitSha,
      failureCode: "PULL_REQUEST_RESPONSE_INVALID",
    };
  }

  const afterPullRequest = await readCurrentDefaultBranch(input);
  if (afterPullRequest.status === "STALE") {
    let closed = false;
    try {
      closed = await withProposalTimeout(input, "PROPOSAL_CLOSE", (signal) => writer.closePullRequest({
        repositoryId: input.repository.repositoryId,
        repositoryFullName: input.repository.fullName,
        pullRequestNumber: pullRequest.number,
        signal,
      }));
    } catch {
      closed = false;
    }
    return {
      ...base,
      status: "STALE",
      changedFiles: [TECHNICAL_PROFILE_PATH],
      branchName,
      commitSha: commit.commitSha,
      pullRequest: { number: pullRequest.number, url: pullRequest.url },
      failureCode: closed ? "STALE_PULL_REQUEST_CLOSED" : "STALE_PULL_REQUEST_CLOSE_FAILED",
    };
  }
  if (afterPullRequest.status !== "CURRENT") {
    return {
      ...base,
      status: "FAILED",
      changedFiles: [TECHNICAL_PROFILE_PATH],
      branchName,
      commitSha: commit.commitSha,
      pullRequest: { number: pullRequest.number, url: pullRequest.url },
      failureCode: afterPullRequest.code,
    };
  }

  return {
    ...base,
    status: "CREATED",
    changedFiles: [TECHNICAL_PROFILE_PATH],
    branchName,
    commitSha: commit.commitSha.toLowerCase(),
    pullRequest: { number: pullRequest.number, url: pullRequest.url },
  };
}

function validateAuthorization(input: ProposalInput, candidateSha256: string): ProposalFailureCode | undefined {
  const authorization = input.authorization;
  if (authorization === undefined) {
    return "AUTHORIZATION_MISSING";
  }
  if (input.gate.status !== "PASS" || input.gate.blockingFailures.length > 0) {
    return "GATE_NOT_PASSED";
  }
  if (candidateSha256.length !== 64 || input.reconciliation.candidate === undefined ||
    input.reconciliation.candidateSha256?.toLowerCase() !== candidateSha256) {
    return "CANDIDATE_DIGEST_MISMATCH";
  }
  if (input.composition.schemaVersion !== 1 || input.reconciliation.schemaVersion !== 1) {
    return "SCHEMA_UNSUPPORTED";
  }
  if (typeof authorization !== "object" || authorization === null || authorization.status !== "AUTHORIZED") {
    return "AUTHORIZATION_INVALID";
  }
  if (authorization.allowedArtifactPath !== TECHNICAL_PROFILE_PATH) {
    return "ARTIFACT_PATH_INVALID";
  }
  if (typeof authorization.binding !== "object" || authorization.binding === null) {
    return "AUTHORIZATION_INVALID";
  }

  let normalizedTarget: string;
  try {
    normalizedTarget = normalizeRepositoryIdentifier(input.configuration.targetRepository);
  } catch {
    return "TARGET_BINDING_MISMATCH";
  }
  if (
    normalizedTarget !== input.configuration.normalizedRepositoryId.toLowerCase() ||
    normalizedTarget !== input.repository.normalizedRepositoryId.toLowerCase() ||
    normalizedTarget !== input.repository.fullName.toLowerCase() ||
    normalizedTarget !== input.filtered.repositoryId.toLowerCase() ||
    normalizedTarget !== input.reconciliation.repositoryId.toLowerCase() ||
    authorization.binding.targetRepository !== normalizedTarget ||
    authorization.binding.repositoryId !== normalizedTarget ||
    authorization.binding.githubRepositoryId !== input.repository.repositoryId
  ) {
    return "TARGET_BINDING_MISMATCH";
  }
  if (
    input.snapshot.commitSha.toLowerCase() !== input.filtered.snapshotCommitSha.toLowerCase() ||
    authorization.binding.snapshotCommitSha !== input.snapshot.commitSha.toLowerCase() ||
    input.snapshot.branch !== input.repository.defaultBranch ||
    authorization.binding.snapshotCommitSha !== input.filtered.snapshotCommitSha.toLowerCase() ||
    input.reconciliation.snapshotCommitSha.toLowerCase() !== input.snapshot.commitSha.toLowerCase()
  ) {
    return "SNAPSHOT_BINDING_MISMATCH";
  }
  if (authorization.binding.schemaVersion !== input.composition.schemaVersion) {
    return "SCHEMA_UNSUPPORTED";
  }
  if (authorization.binding.candidateSha256 !== candidateSha256) {
    return "CANDIDATE_DIGEST_MISMATCH";
  }
  if (
    authorization.binding.gateVersion !== MANDATORY_GATE_VERSION ||
    authorization.binding.validatorVersion !== VALIDATOR_VERSION ||
    authorization.binding.testSuiteVersion !== AUTOMATED_TEST_SUITE_VERSION ||
    authorization.binding.scannerId !== input.filtered.scan.scanner ||
    authorization.binding.scannerVersion !== safeVersion(input.scannerVersion)
  ) {
    return "AUTHORIZATION_INVALID";
  }
  const expectedBinding = {
    runId: input.runId,
    targetRepository: normalizedTarget,
    repositoryId: input.repository.normalizedRepositoryId.toLowerCase(),
    githubRepositoryId: input.repository.repositoryId,
    snapshotCommitSha: input.snapshot.commitSha.toLowerCase(),
    candidateSha256,
    schemaVersion: input.composition.schemaVersion,
    gateVersion: MANDATORY_GATE_VERSION,
    validatorVersion: VALIDATOR_VERSION,
    testSuiteVersion: AUTOMATED_TEST_SUITE_VERSION,
    scannerId: input.filtered.scan.scanner,
    scannerVersion: safeVersion(input.scannerVersion) ?? "",
  };
  if (!sameBinding(authorization.binding, expectedBinding)) {
    return authorization.binding.snapshotCommitSha !== expectedBinding.snapshotCommitSha
      ? "SNAPSHOT_BINDING_MISMATCH"
      : authorization.binding.candidateSha256 !== expectedBinding.candidateSha256
        ? "CANDIDATE_DIGEST_MISMATCH"
        : authorization.binding.targetRepository !== expectedBinding.targetRepository ||
          authorization.binding.repositoryId !== expectedBinding.repositoryId ||
          authorization.binding.githubRepositoryId !== expectedBinding.githubRepositoryId
          ? "TARGET_BINDING_MISMATCH"
          : "AUTHORIZATION_INVALID";
  }
  if (!isGatePassBoundTo(input.gate, expectedBinding)) {
    return "AUTHORIZATION_INVALID";
  }
  return undefined;
}

function validateWriteCapability(
  capability: ProposalWriteCapability,
  input: ProposalInput,
): ProposalFailureCode | undefined {
  if (capability.provider !== "dedicated_github_proposal_app") {
    return "PROPOSAL_CAPABILITY_UNSAFE";
  }
  if (
    capability.repositoryId !== input.repository.repositoryId ||
    capability.normalizedRepositoryId.toLowerCase() !== input.configuration.normalizedRepositoryId.toLowerCase()
  ) {
    return "PROPOSAL_CAPABILITY_SCOPE_MISMATCH";
  }
  const { permissions, branchProtection } = capability;
  if (
    permissions.contents !== "write" || permissions.pullRequests !== "write" ||
    permissions.canApprove !== false || permissions.canMerge !== false ||
    permissions.canBypassBranchProtection !== false || permissions.canWriteDefaultBranch !== false ||
    branchProtection.pullRequestRequired !== true || branchProtection.humanApprovalRequired !== true ||
    branchProtection.proposalAppBypass !== false
  ) {
    return "PROPOSAL_CAPABILITY_UNSAFE";
  }
  return undefined;
}

type CurrentSnapshotResult =
  | { status: "CURRENT"; metadata: GitHubRepositoryMetadata; snapshot: GitHubCommitSnapshot }
  | { status: "STALE" }
  | { status: "FAILED"; code: "SNAPSHOT_BINDING_MISMATCH" | "PROPOSAL_TIMED_OUT" };

async function readCurrentDefaultBranch(input: ProposalInput): Promise<CurrentSnapshotResult> {
  try {
    assertProposalDeadline(input);
    const metadata = await input.readClient.getRepositoryMetadata(input.configuration);
    assertProposalDeadline(input);
    if (
      metadata.normalizedRepositoryId.toLowerCase() !== input.configuration.normalizedRepositoryId.toLowerCase() ||
      metadata.repositoryId !== input.repository.repositoryId ||
      metadata.fullName.toLowerCase() !== input.configuration.normalizedRepositoryId.toLowerCase()
    ) {
      return { status: "FAILED", code: "SNAPSHOT_BINDING_MISMATCH" };
    }
    if (metadata.defaultBranch !== input.repository.defaultBranch) {
      return { status: "STALE" };
    }
    const snapshot = await input.readClient.getDefaultBranchCommit(input.configuration, metadata.defaultBranch);
    assertProposalDeadline(input);
    if (snapshot.branch !== metadata.defaultBranch || !isGitSha(snapshot.commitSha) || !isGitSha(snapshot.treeSha)) {
      return { status: "FAILED", code: "SNAPSHOT_BINDING_MISMATCH" };
    }
    if (
      snapshot.commitSha.toLowerCase() !== input.authorization?.binding.snapshotCommitSha ||
      snapshot.treeSha.toLowerCase() !== input.snapshot.treeSha.toLowerCase()
    ) {
      return { status: "STALE" };
    }
    return { status: "CURRENT", metadata, snapshot };
  } catch (error) {
    if (error instanceof OperationalTimeoutError) {
      return { status: "FAILED", code: "PROPOSAL_TIMED_OUT" };
    }
    return { status: "FAILED", code: "SNAPSHOT_BINDING_MISMATCH" };
  }
}

async function withProposalTimeout<T>(
  input: ProposalInput,
  stage: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  assertProposalDeadline(input);
  const limits = resolveOperationalLimits(input.proposalOperationTimeoutMs === undefined
    ? {}
    : { proposalOperationTimeoutMs: input.proposalOperationTimeoutMs });
  const remaining = input.deadlineAtMs === undefined ? limits.proposalOperationTimeoutMs : input.deadlineAtMs - Date.now();
  if (remaining <= 0) throw new OperationalTimeoutError(stage);
  return withFiniteTimeout(operation, Math.min(limits.proposalOperationTimeoutMs, remaining), stage);
}

function assertProposalDeadline(input: ProposalInput): void {
  if (input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs) {
    throw new OperationalTimeoutError("PROPOSAL");
  }
}

function proposalFailureFromError(error: unknown, fallback: ProposalFailureCode): ProposalFailureCode {
  return error instanceof OperationalTimeoutError ? "PROPOSAL_TIMED_OUT" : fallback;
}

function validCommitResult(
  result: ProposalCommitResult,
  input: ProposalInput,
  candidateSha256: string,
): boolean {
  return Array.isArray(result.changedPaths) && result.changedPaths.length === 1 &&
    result.changedPaths.every((path) => typeof path === "string") &&
    isGitSha(result.commitSha) && isGitSha(result.treeSha) &&
    result.parentCommitSha.toLowerCase() === input.snapshot.commitSha.toLowerCase() &&
    result.profileSha256.toLowerCase() === candidateSha256 &&
    result.changedPaths[0] === TECHNICAL_PROFILE_PATH;
}

function validPullRequest(
  result: ProposalPullRequestResult,
  headBranch: string,
  baseBranch: string,
  repositoryFullName: string,
): boolean {
  if (
    !Number.isSafeInteger(result.number) || result.number < 1 || result.state !== "open" ||
    result.headBranch !== headBranch || result.baseBranch !== baseBranch
  ) {
    return false;
  }
  try {
    const url = new URL(result.url);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      url.pathname.toLowerCase() === `/${repositoryFullName.toLowerCase()}/pull/${result.number}`;
  } catch {
    return false;
  }
}

function pullRequestBody(input: ProposalInput, candidateSha256: string): string {
  const shortSnapshot = input.snapshot.commitSha.slice(0, 12);
  return [
    "### Summary",
    "Automated technical profile synchronization.",
    "",
    "### Validation",
    "- Gate: PASS",
    `- Snapshot: ${shortSnapshot}`,
    `- Profile digest: ${candidateSha256}`,
  ].join("\n");
}

function proposalBranchName(runId: string, candidateSha256: string): string {
  const safeRunId = runId.replace(/^run-/i, "").replace(/[^A-Za-z0-9-]/g, "").toLowerCase();
  return `docs-sync/technical-profile/${safeRunId}-${candidateSha256.slice(0, 12)}`;
}

function blocked(
  base: Omit<ProposalResult, "status" | "changedFiles">,
  code: ProposalFailureCode,
): ProposalResult {
  return { ...base, status: "BLOCKED", changedFiles: [], failureCode: code };
}

function safeVersion(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function sameBinding(left: ProposalAuthorization["binding"], right: ProposalAuthorization["binding"]): boolean {
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

function sanitizeChangedPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => path === TECHNICAL_PROFILE_PATH);
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function isClosableProposalPullRequest(
  value: ProposalPullRequestResult,
  headBranch: string,
  repositoryFullName: string,
): boolean {
  if (
    value === null || typeof value !== "object" || !Number.isSafeInteger(value.number) || value.number < 1 ||
    value.state !== "open" || value.headBranch !== headBranch
  ) {
    return false;
  }
  try {
    const url = new URL(value.url);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      url.pathname.toLowerCase() === `/${repositoryFullName.toLowerCase()}/pull/${value.number}`;
  } catch {
    return false;
  }
}