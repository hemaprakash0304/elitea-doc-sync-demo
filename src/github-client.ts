import type { RunConfiguration } from "./config.js";
import { createDefaultCredentialProvider, type GitHubReadCredentialProvider } from "./github-credentials.js";
import { GitHubReadError } from "./github-errors.js";

export interface GitHubRepositoryMetadata {
  repositoryId: number;
  normalizedRepositoryId: string;
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
  readRetryCount: number;
}

export interface GitHubReadClient {
  getRepositoryMetadata(configuration: RunConfiguration): Promise<GitHubRepositoryMetadata>;
  getDefaultBranchCommit(configuration: RunConfiguration, branch: string): Promise<GitHubCommitSnapshot>;
  getRepositoryTree(configuration: RunConfiguration, treeSha: string): Promise<GitHubRepositoryTree>;
  getGitBlob(configuration: RunConfiguration, blobSha: string): Promise<GitHubBlob>;
}

export interface GitHubCommitSnapshot {
  branch: string;
  commitSha: string;
  treeSha: string;
  readRetryCount: number;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export interface GitHubRepositoryTree {
  treeSha: string;
  entries: GitHubTreeEntry[];
  truncated: boolean;
  readRetryCount: number;
}

export interface GitHubBlob {
  sha: string;
  size: number;
  encoding: string;
  content: string;
  readRetryCount: number;
}

export interface GitHubClientOptions {
  credentialProvider?: GitHubReadCredentialProvider;
  fetchImplementation?: typeof fetch;
  maxReadAttempts?: number;
  requestTimeoutMs?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_MAX_READ_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BASE_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;
const MAX_READ_ATTEMPTS = 3;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

export class GitHubRestClient implements GitHubReadClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxReadAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly readTokens = new Map<string, string>();

  constructor(private readonly options: GitHubClientOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    const requestedAttempts = options.maxReadAttempts ?? DEFAULT_MAX_READ_ATTEMPTS;
    this.maxReadAttempts = Number.isFinite(requestedAttempts)
      ? Math.min(MAX_READ_ATTEMPTS, Math.max(1, Math.floor(requestedAttempts)))
      : DEFAULT_MAX_READ_ATTEMPTS;
    this.requestTimeoutMs = boundedNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1, MAX_REQUEST_TIMEOUT_MS);
    this.baseRetryDelayMs = boundedNumber(options.baseRetryDelayMs, DEFAULT_BASE_RETRY_DELAY_MS, 0, DEFAULT_MAX_RETRY_DELAY_MS);
    this.maxRetryDelayMs = boundedNumber(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS, 0, DEFAULT_MAX_RETRY_DELAY_MS);
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async getRepositoryMetadata(configuration: RunConfiguration): Promise<GitHubRepositoryMetadata> {
    const url = repositoryMetadataUrl(configuration.targetRepository);
    const result = await this.getJsonResource(url, configuration, "REPOSITORY_NOT_FOUND");
    return parseWithRetryCount(
      () => parseRepositoryMetadata(result.value, configuration, result.retryCount),
      result.retryCount,
    );
  }

  async getDefaultBranchCommit(configuration: RunConfiguration, branch: string): Promise<GitHubCommitSnapshot> {
    const url = `${repositoryMetadataUrl(configuration.targetRepository)}/branches/${encodeURIComponent(branch)}`;
    const result = await this.getJsonResource(url, configuration, "DEFAULT_BRANCH_COMMIT_MISSING");
    return parseWithRetryCount(() => parseBranchCommit(result.value, branch, result.retryCount), result.retryCount);
  }

  async getRepositoryTree(configuration: RunConfiguration, treeSha: string): Promise<GitHubRepositoryTree> {
    if (!isGitSha(treeSha)) {
      throw new GitHubReadError("SNAPSHOT_INCONSISTENT");
    }
    const url = `${repositoryMetadataUrl(configuration.targetRepository)}/git/trees/${treeSha}?recursive=1`;
    const result = await this.getJsonResource(url, configuration, "TREE_RETRIEVAL_FAILED");
    return parseWithRetryCount(() => parseRepositoryTree(result.value, treeSha, result.retryCount), result.retryCount);
  }

  async getGitBlob(configuration: RunConfiguration, blobSha: string): Promise<GitHubBlob> {
    if (!isGitSha(blobSha)) {
      throw new GitHubReadError("SNAPSHOT_INCONSISTENT");
    }
    const url = `${repositoryMetadataUrl(configuration.targetRepository)}/git/blobs/${blobSha}`;
    const result = await this.getJsonResource(url, configuration, "BLOB_RETRIEVAL_FAILED");
    const blobResponse = result.value;
    if (isRawBlobResponse(blobResponse, blobSha)) {
      let raw: { bytes: Buffer; retryCount: number };
      try {
        raw = await this.getRawResource(url, configuration, "BLOB_RETRIEVAL_FAILED");
      } catch (error) {
        if (error instanceof GitHubReadError) {
          throw new GitHubReadError(error.code, result.retryCount + error.retryCount);
        }
        throw new GitHubReadError("BLOB_RETRIEVAL_FAILED", result.retryCount);
      }
      if (raw.bytes.length !== blobResponse.size) {
        throw new GitHubReadError("SNAPSHOT_INCONSISTENT", result.retryCount + raw.retryCount);
      }
      return parseWithRetryCount(
        () => parseGitBlob({
          ...blobResponse,
          encoding: "base64",
          content: raw.bytes.toString("base64"),
        }, blobSha, result.retryCount + raw.retryCount),
        result.retryCount + raw.retryCount,
      );
    }
    return parseWithRetryCount(() => parseGitBlob(result.value, blobSha, result.retryCount), result.retryCount);
  }

  private async getJsonResource(
    url: string,
    configuration: RunConfiguration,
    notFoundCode: GitHubReadError["code"],
  ): Promise<{ value: unknown; retryCount: number }> {
    const result = await this.getResourceResponse(url, configuration, notFoundCode);
    try {
      return { value: await result.response.json(), retryCount: result.retryCount };
    } catch {
      throw new GitHubReadError("INVALID_RESPONSE", result.retryCount);
    }
  }

  private async getRawResource(
    url: string,
    configuration: RunConfiguration,
    notFoundCode: GitHubReadError["code"],
  ): Promise<{ bytes: Buffer; retryCount: number }> {
    const result = await this.getResourceResponse(url, configuration, notFoundCode, "application/vnd.github.raw");
    try {
      return { bytes: Buffer.from(await result.response.arrayBuffer()), retryCount: result.retryCount };
    } catch {
      throw new GitHubReadError("INVALID_RESPONSE", result.retryCount);
    }
  }

  private async getResourceResponse(
    url: string,
    configuration: RunConfiguration,
    notFoundCode: GitHubReadError["code"],
    accept = "application/vnd.github+json",
  ): Promise<{ response: Response; retryCount: number }> {
    let token = this.readTokens.get(configuration.normalizedRepositoryId);
    let result = await this.getWithRetry(url, token, accept);
    let retryCount = result.retryCount;

    if (result.response.status === 404 && token === undefined) {
      try {
        token = await this.options.credentialProvider?.getReadToken(configuration);
      } catch (error) {
        if (error instanceof GitHubReadError) {
          throw new GitHubReadError(error.code, retryCount + error.retryCount);
        }
        throw new GitHubReadError("CREDENTIAL_STORE_UNAVAILABLE", retryCount);
      }

      if (token !== undefined) {
        this.readTokens.set(configuration.normalizedRepositoryId, token);
        result = await this.getWithRetry(url, token, accept);
        retryCount += result.retryCount;
      }
    }

    const response = result.response;
    if (response.status === 404) {
      throw new GitHubReadError(notFoundCode, retryCount);
    }
    if (response.status === 401) {
      throw new GitHubReadError("AUTHENTICATION_FAILED", retryCount);
    }
    if (isRateLimited(response)) {
      throw new GitHubReadError("RATE_LIMITED", retryCount);
    }
    if (response.status === 403) {
      throw new GitHubReadError("AUTHORIZATION_FAILED", retryCount);
    }
    if (!response.ok) {
      throw new GitHubReadError(response.status >= 500 ? "SERVICE_UNAVAILABLE" : "INVALID_RESPONSE", retryCount);
    }

    return { response, retryCount };
  }

  private async getWithRetry(
    url: string,
    token?: string,
    accept = "application/vnd.github+json",
  ): Promise<{ response: Response; retryCount: number }> {
    let retryCount = 0;

    while (retryCount < this.maxReadAttempts) {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          method: "GET",
          headers: {
            Accept: accept,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch {
        retryCount += 1;
        if (retryCount >= this.maxReadAttempts) {
          throw new GitHubReadError("NETWORK_FAILURE", retryCount - 1);
        }
        await this.waitBeforeRetry(undefined, retryCount - 1);
        continue;
      }

      if (!isRetryableResponse(response)) {
        return { response, retryCount };
      }

      retryCount += 1;
      if (retryCount >= this.maxReadAttempts) {
        throw new GitHubReadError(isRateLimited(response) ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", retryCount - 1);
      }
      await this.waitBeforeRetry(response, retryCount - 1);
    }

    throw new GitHubReadError("NETWORK_FAILURE", retryCount);
  }

  private async waitBeforeRetry(response: Response | undefined, retryIndex: number): Promise<void> {
    const requestedDelay = response === undefined
      ? this.baseRetryDelayMs * 2 ** retryIndex
      : serverRetryDelay(response) ?? this.baseRetryDelayMs * 2 ** retryIndex;
    if (requestedDelay > this.maxRetryDelayMs) {
      throw new GitHubReadError(response !== undefined && isRateLimited(response) ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", retryIndex + 1);
    }
    await this.sleep(requestedDelay);
  }
}

export function createGitHubReadClient(
  executionContext: RunConfiguration["executionContext"],
  options: Omit<GitHubClientOptions, "credentialProvider"> & { environment?: NodeJS.ProcessEnv } = {},
): GitHubReadClient {
  const credentialProvider = createDefaultCredentialProvider({
    executionContext,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
  });
  return new GitHubRestClient({ ...options, credentialProvider });
}

function repositoryMetadataUrl(targetRepository: string): string {
  const [owner, repository] = targetRepository.split("/");
  if (owner === undefined || repository === undefined) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  return `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function parseRepositoryMetadata(
  value: unknown,
  configuration: RunConfiguration,
  readRetryCount: number,
): GitHubRepositoryMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }

  const metadata = value as Record<string, unknown>;
  if (
    typeof metadata.id !== "number" || !Number.isSafeInteger(metadata.id) || metadata.id <= 0 ||
    typeof metadata.full_name !== "string" ||
    typeof metadata.private !== "boolean"
  ) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  if (metadata.full_name.toLowerCase() !== configuration.normalizedRepositoryId) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  if (
    typeof metadata.default_branch !== "string" ||
    metadata.default_branch.trim().length === 0 ||
    metadata.default_branch.trim() !== metadata.default_branch ||
    /[\u0000-\u001f\u007f]/.test(metadata.default_branch)
  ) {
    throw new GitHubReadError("DEFAULT_BRANCH_MISSING");
  }

  return {
    repositoryId: metadata.id,
    normalizedRepositoryId: configuration.normalizedRepositoryId,
    fullName: metadata.full_name,
    isPrivate: metadata.private,
    defaultBranch: metadata.default_branch,
    readRetryCount,
  };
}

function parseBranchCommit(value: unknown, requestedBranch: string, readRetryCount: number): GitHubCommitSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  const branch = value as Record<string, unknown>;
  if (branch.name !== requestedBranch || typeof branch.commit !== "object" || branch.commit === null) {
    throw new GitHubReadError("SNAPSHOT_INCONSISTENT");
  }

  const commit = branch.commit as Record<string, unknown>;
  if (
    typeof commit.sha !== "string" || !isGitSha(commit.sha) ||
    typeof commit.commit !== "object" || commit.commit === null
  ) {
    throw new GitHubReadError("DEFAULT_BRANCH_COMMIT_MISSING");
  }
  const commitDetails = commit.commit as Record<string, unknown>;
  if (typeof commitDetails.tree !== "object" || commitDetails.tree === null) {
    throw new GitHubReadError("DEFAULT_BRANCH_COMMIT_MISSING");
  }
  const tree = commitDetails.tree as Record<string, unknown>;
  if (typeof tree.sha !== "string" || !isGitSha(tree.sha)) {
    throw new GitHubReadError("DEFAULT_BRANCH_COMMIT_MISSING");
  }

  return {
    branch: requestedBranch,
    commitSha: commit.sha.toLowerCase(),
    treeSha: tree.sha.toLowerCase(),
    readRetryCount,
  };
}

function parseRepositoryTree(value: unknown, requestedTreeSha: string, readRetryCount: number): GitHubRepositoryTree {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  const treeResponse = value as Record<string, unknown>;
  if (
    typeof treeResponse.sha !== "string" ||
    typeof treeResponse.truncated !== "boolean" ||
    !Array.isArray(treeResponse.tree)
  ) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  if (treeResponse.sha.toLowerCase() !== requestedTreeSha.toLowerCase() || treeResponse.truncated) {
    throw new GitHubReadError("SNAPSHOT_INCONSISTENT");
  }

  const entries = treeResponse.tree.map((entry): GitHubTreeEntry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new GitHubReadError("INVALID_RESPONSE");
    }
    const record = entry as Record<string, unknown>;
    if (
      typeof record.path !== "string" || !isSafeGitPath(record.path) ||
      typeof record.mode !== "string" || !/^\d{6}$/.test(record.mode) ||
      (record.type !== "blob" && record.type !== "tree" && record.type !== "commit") ||
      typeof record.sha !== "string" || !isGitSha(record.sha) ||
      (record.type === "blob" && record.size === undefined)
    ) {
      throw new GitHubReadError("INVALID_RESPONSE");
    }
    if (record.size !== undefined && (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0)) {
      throw new GitHubReadError("INVALID_RESPONSE");
    }

    return {
      path: record.path,
      mode: record.mode,
      type: record.type,
      sha: record.sha.toLowerCase(),
      ...(typeof record.size === "number" ? { size: record.size } : {}),
    };
  });

  return {
    treeSha: requestedTreeSha.toLowerCase(),
    entries,
    truncated: false,
    readRetryCount,
  };
}

function parseGitBlob(value: unknown, requestedSha: string, readRetryCount: number): GitHubBlob {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  const blob = value as Record<string, unknown>;
  if (
    typeof blob.sha !== "string" || blob.sha.toLowerCase() !== requestedSha.toLowerCase() ||
    typeof blob.size !== "number" || !Number.isSafeInteger(blob.size) || blob.size < 0 ||
    blob.encoding !== "base64" || typeof blob.content !== "string"
  ) {
    throw new GitHubReadError("SNAPSHOT_INCONSISTENT");
  }

  const content = blob.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
    throw new GitHubReadError("INVALID_RESPONSE");
  }
  return {
    sha: blob.sha.toLowerCase(),
    size: blob.size,
    encoding: "base64",
    content,
    readRetryCount,
  };
}

function parseWithRetryCount<T>(parse: () => T, readRetryCount: number): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof GitHubReadError) {
      throw new GitHubReadError(error.code, readRetryCount);
    }
    throw new GitHubReadError("INVALID_RESPONSE", readRetryCount);
  }
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isSafeGitPath(value: string): boolean {
  return value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isRetryableResponse(response: Response): boolean {
  return isRateLimited(response) || [500, 502, 503, 504].includes(response.status);
}

function isRateLimited(response: Response): boolean {
  return response.status === 429 ||
    (response.status === 403 && (
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after")
    ));
}

function serverRetryDelay(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) {
      return Math.max(0, retryAt - Date.now());
    }
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset !== null && /^\d+$/.test(reset)) {
    return Math.max(0, Number(reset) * 1_000 - Date.now());
  }
  return undefined;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function isRawBlobResponse(
  value: unknown,
  expectedSha: string,
): value is Record<string, unknown> & { sha: string; size: number; encoding: "none"; content: "" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const blob = value as Record<string, unknown>;
  return blob.encoding === "none" &&
    blob.content === "" &&
    typeof blob.size === "number" && Number.isSafeInteger(blob.size) && blob.size >= 0 &&
    typeof blob.sha === "string" && blob.sha.toLowerCase() === expectedSha.toLowerCase();
}