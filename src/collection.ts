import type { RunConfiguration } from "./config.js";
import type {
  GitHubCommitSnapshot,
  GitHubReadClient,
  GitHubRepositoryMetadata,
  GitHubTreeEntry,
} from "./github-client.js";
import { GitHubReadError } from "./github-errors.js";

export const MAX_COLLECTION_FILES = 5_000;
export const MAX_COLLECTION_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_COLLECTION_TEXT_BYTES = 20 * 1024 * 1024;
export const TECHNICAL_PROFILE_PATH = "technical-profile.md";

export type CollectedEntryKind = "regular" | "symlink" | "submodule" | "unsupported";
export type CollectedContentStatus =
  | "text"
  | "binary"
  | "unreadable"
  | "file_size_limit"
  | "total_text_limit"
  | "file_count_limit"
  | "symlink_not_followed"
  | "submodule_not_fetched"
  | "unsupported_entry"
  | "retrieval_failed";

export type CollectionIssueCode =
  | "FILE_COUNT_LIMIT"
  | "FILE_SIZE_LIMIT"
  | "TOTAL_TEXT_LIMIT"
  | "FILE_RETRIEVAL_FAILED"
  | "SNAPSHOT_ENTRY_MISMATCH";

export interface CollectedFile {
  path: string;
  extension: string | null;
  mode: string;
  kind: CollectedEntryKind;
  size: number;
  blobSha: string | null;
  sourceCommitSha: string;
  contentStatus: CollectedContentStatus;
  content?: string;
  retrievalErrorCode?: CollectionErrorCode;
}

export type ExistingProfileInput =
  | { profilePresent: false }
  | { profilePresent: true; file: CollectedFile };

export interface CollectionIssue {
  code: CollectionIssueCode;
  count: number;
}

export interface RepositoryCollectionResult {
  status: "complete" | "partial";
  repository: GitHubRepositoryMetadata;
  defaultBranch: string;
  snapshotCommitSha: string;
  snapshotTreeSha: string;
  files: CollectedFile[];
  existingProfile: ExistingProfileInput;
  totalTextBytes: number;
  issues: CollectionIssue[];
  readRetryCount: number;
}

export type CollectionErrorCode =
  | "REPOSITORY_NOT_FOUND"
  | "AUTHENTICATION_FAILED"
  | "ACCESS_DENIED"
  | "RATE_LIMITED"
  | "NETWORK_FAILURE"
  | "SERVICE_UNAVAILABLE"
  | "CREDENTIAL_CONFIGURATION_INVALID"
  | "CREDENTIAL_STORE_UNAVAILABLE"
  | "MISSING_COMMIT_METADATA"
  | "TREE_RETRIEVAL_FAILED"
  | "FILE_RETRIEVAL_FAILED"
  | "INVALID_GITHUB_RESPONSE"
  | "SNAPSHOT_INCONSISTENT"
  | "RUN_TIMEOUT";

const SAFE_COLLECTION_MESSAGES: Record<CollectionErrorCode, string> = {
  REPOSITORY_NOT_FOUND: "Repository is unavailable to the configured read identity.",
  AUTHENTICATION_FAILED: "GitHub authentication failed during repository collection.",
  ACCESS_DENIED: "GitHub denied read access during repository collection.",
  RATE_LIMITED: "GitHub rate limiting prevented repository collection.",
  NETWORK_FAILURE: "GitHub could not be reached during repository collection.",
  SERVICE_UNAVAILABLE: "GitHub is temporarily unavailable during repository collection.",
  CREDENTIAL_CONFIGURATION_INVALID: "The approved read credential configuration is invalid.",
  CREDENTIAL_STORE_UNAVAILABLE: "The operating-system credential store is unavailable.",
  MISSING_COMMIT_METADATA: "The default branch did not resolve to a complete commit snapshot.",
  TREE_RETRIEVAL_FAILED: "The repository tree could not be read for the selected snapshot.",
  FILE_RETRIEVAL_FAILED: "A repository file could not be read from the selected snapshot.",
  INVALID_GITHUB_RESPONSE: "GitHub returned invalid data during repository collection.",
  SNAPSHOT_INCONSISTENT: "Repository data could not be bound to one immutable commit snapshot.",
  RUN_TIMEOUT: "The repository collection exceeded its configured run deadline.",
};

export class RepositoryCollectionError extends Error {
  readonly code: CollectionErrorCode;
  readonly retryCount: number;

  constructor(code: CollectionErrorCode, retryCount = 0) {
    super(SAFE_COLLECTION_MESSAGES[code]);
    this.name = "RepositoryCollectionError";
    this.code = code;
    this.retryCount = retryCount;
  }
}

export interface CollectionOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTextBytes?: number;
  deadlineAtMs?: number;
}

const KNOWN_BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".cer", ".crt", ".der", ".dylib", ".ear", ".exe",
  ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".jks", ".keystore", ".kdbx", ".key", ".lib",
  ".mov", ".mp3", ".mp4", ".o", ".p12", ".p7b", ".p7c", ".pem", ".pfx", ".png", ".ppk", ".so",
  ".tar", ".tgz", ".tif", ".tiff", ".war", ".wav", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
]);
export async function collectRepositorySnapshot(
  configuration: RunConfiguration,
  repository: GitHubRepositoryMetadata,
  client: GitHubReadClient,
  options: CollectionOptions = {},
): Promise<RepositoryCollectionResult> {
  const limits = resolveLimits(options);
  assertDeadline(limits.deadlineAtMs);
  const snapshot = await resolveSnapshot(configuration, repository, client);
  assertDeadline(limits.deadlineAtMs);
  let tree;
  try {
    tree = await client.getRepositoryTree(configuration, snapshot.treeSha);
  } catch (error) {
    throw mapCollectionError(error, "TREE_RETRIEVAL_FAILED");
  }
  if (tree.treeSha !== snapshot.treeSha || tree.truncated) {
    throw new RepositoryCollectionError("SNAPSHOT_INCONSISTENT", tree.readRetryCount);
  }

  const treeEntries = tree.entries
    .filter((entry) => entry.type === "blob" || entry.type === "commit")
    .sort(comparePaths);
  ensureUniquePaths(treeEntries);

  const profileEntry = treeEntries.find((entry) => entry.path === TECHNICAL_PROFILE_PATH);
  const selectedEntries = selectEntries(treeEntries, profileEntry, limits.maxFiles);
  const issues = new Map<CollectionIssueCode, number>();
  if (treeEntries.length > selectedEntries.length) {
    issues.set("FILE_COUNT_LIMIT", treeEntries.length - selectedEntries.length);
  }

  let reservedTextBytes = 0;
  let totalTextBytes = 0;
  let readRetryCount = snapshot.readRetryCount + tree.readRetryCount;
  const collectedFiles: CollectedFile[] = [];

  for (const entry of selectedEntries) {
    assertDeadline(limits.deadlineAtMs);
    const file = createMetadata(entry, snapshot.commitSha);
    if (file.kind === "symlink") {
      file.contentStatus = "symlink_not_followed";
      collectedFiles.push(file);
      continue;
    }
    if (file.kind === "submodule") {
      file.contentStatus = "submodule_not_fetched";
      collectedFiles.push(file);
      continue;
    }
    if (file.kind === "unsupported") {
      file.contentStatus = "unsupported_entry";
      collectedFiles.push(file);
      continue;
    }
    if (isKnownBinaryPath(file.path)) {
      file.contentStatus = "binary";
      collectedFiles.push(file);
      continue;
    }
    if (file.size > limits.maxFileBytes) {
      file.contentStatus = "file_size_limit";
      addIssue(issues, "FILE_SIZE_LIMIT");
      collectedFiles.push(file);
      continue;
    }
    if (reservedTextBytes + file.size > limits.maxTextBytes) {
      file.contentStatus = "total_text_limit";
      addIssue(issues, "TOTAL_TEXT_LIMIT");
      collectedFiles.push(file);
      continue;
    }

    reservedTextBytes += file.size;
    try {
      const blob = await client.getGitBlob(configuration, file.blobSha as string);
      assertDeadline(limits.deadlineAtMs);
      readRetryCount += blob.readRetryCount;
      if (blob.sha !== file.blobSha || blob.size !== file.size) {
        throw new RepositoryCollectionError("SNAPSHOT_INCONSISTENT");
      }

      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length !== file.size) {
        throw new RepositoryCollectionError("SNAPSHOT_INCONSISTENT");
      }
      if (looksBinaryBytes(bytes)) {
        file.contentStatus = "binary";
        reservedTextBytes -= file.size;
        collectedFiles.push(file);
        continue;
      }

      try {
        file.content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        file.contentStatus = "text";
        totalTextBytes += bytes.length;
      } catch {
        file.contentStatus = "unreadable";
        reservedTextBytes -= file.size;
      }
    } catch (error) {
      if (error instanceof RepositoryCollectionError && error.code === "SNAPSHOT_INCONSISTENT") {
        throw error;
      }
      const mappedError = mapCollectionError(error, "FILE_RETRIEVAL_FAILED");
      readRetryCount += mappedError.retryCount;
      if (
        mappedError.code === "REPOSITORY_NOT_FOUND" ||
        mappedError.code === "AUTHENTICATION_FAILED" ||
        mappedError.code === "ACCESS_DENIED" ||
        mappedError.code === "RATE_LIMITED" ||
        mappedError.code === "CREDENTIAL_CONFIGURATION_INVALID" ||
        mappedError.code === "CREDENTIAL_STORE_UNAVAILABLE"
      ) {
        throw mappedError;
      }
      file.contentStatus = "retrieval_failed";
      file.retrievalErrorCode = mappedError.code;
      reservedTextBytes -= file.size;
      addIssue(issues, "FILE_RETRIEVAL_FAILED");
    }
    collectedFiles.push(file);
  }

  collectedFiles.sort(compareCollectedFiles);
  const existingProfileFile = collectedFiles.find((file) => file.path === TECHNICAL_PROFILE_PATH);
  const existingProfile: ExistingProfileInput = existingProfileFile === undefined
    ? { profilePresent: false }
    : { profilePresent: true, file: existingProfileFile };
  const issueList = [...issues.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, count]) => ({ code, count }));

  return {
    status: issueList.length === 0 ? "complete" : "partial",
    repository,
    defaultBranch: repository.defaultBranch,
    snapshotCommitSha: snapshot.commitSha,
    snapshotTreeSha: snapshot.treeSha,
    files: collectedFiles,
    existingProfile,
    totalTextBytes,
    issues: issueList,
    readRetryCount,
  };
}

async function resolveSnapshot(
  configuration: RunConfiguration,
  repository: GitHubRepositoryMetadata,
  client: GitHubReadClient,
): Promise<GitHubCommitSnapshot> {
  try {
    const snapshot = await client.getDefaultBranchCommit(configuration, repository.defaultBranch);
    if (
      snapshot.branch !== repository.defaultBranch ||
      !isGitSha(snapshot.commitSha) ||
      !isGitSha(snapshot.treeSha)
    ) {
      throw new RepositoryCollectionError("SNAPSHOT_INCONSISTENT", snapshot.readRetryCount);
    }
    return snapshot;
  } catch (error) {
    if (error instanceof RepositoryCollectionError) {
      throw error;
    }
    throw mapCollectionError(error, "MISSING_COMMIT_METADATA");
  }
}

function selectEntries(
  entries: GitHubTreeEntry[],
  profileEntry: GitHubTreeEntry | undefined,
  maxFiles: number,
): GitHubTreeEntry[] {
  if (entries.length <= maxFiles) {
    return entries;
  }
  const selected = entries.slice(0, maxFiles);
  if (profileEntry !== undefined && !selected.some((entry) => entry.path === profileEntry.path)) {
    selected[maxFiles - 1] = profileEntry;
  }
  return selected.sort(comparePaths);
}

function createMetadata(entry: GitHubTreeEntry, sourceCommitSha: string): CollectedFile {
  const isSubmodule = entry.type === "commit" || entry.mode === "160000";
  const isSymlink = entry.mode === "120000";
  const isRegular = entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
  const kind: CollectedEntryKind = isSubmodule
    ? "submodule"
    : isSymlink
      ? "symlink"
      : isRegular
        ? "regular"
        : "unsupported";
  return {
    path: entry.path,
    extension: getExtension(entry.path),
    mode: entry.mode,
    kind,
    size: entry.size ?? 0,
    blobSha: entry.type === "blob" ? entry.sha : null,
    sourceCommitSha,
    contentStatus: "unsupported_entry",
  };
}

function isKnownBinaryPath(path: string): boolean {
  const extension = getExtension(path);
  return extension !== null && KNOWN_BINARY_EXTENSIONS.has(extension);
}

function looksBinaryBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) {
    return true;
  }
  if (bytes.length === 0) {
    return false;
  }

  let controlBytes = 0;
  for (const byte of bytes) {
    if (byte < 0x07 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) {
      controlBytes += 1;
    }
  }
  return controlBytes / bytes.length > 0.1;
}

function getExtension(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = name.lastIndexOf(".");
  return dotIndex <= 0 ? null : name.slice(dotIndex).toLowerCase();
}

function comparePaths(left: GitHubTreeEntry, right: GitHubTreeEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function compareCollectedFiles(left: CollectedFile, right: CollectedFile): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function ensureUniquePaths(entries: GitHubTreeEntry[]): void {
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]?.path === entries[index - 1]?.path) {
      throw new RepositoryCollectionError("SNAPSHOT_INCONSISTENT");
    }
  }
}

function addIssue(issues: Map<CollectionIssueCode, number>, code: CollectionIssueCode): void {
  issues.set(code, (issues.get(code) ?? 0) + 1);
}

function resolveLimits(options: CollectionOptions) {
  return {
    maxFiles: boundedLimit(options.maxFiles, MAX_COLLECTION_FILES),
    maxFileBytes: boundedLimit(options.maxFileBytes, MAX_COLLECTION_FILE_BYTES),
    maxTextBytes: boundedLimit(options.maxTextBytes, MAX_COLLECTION_TEXT_BYTES),
    ...(Number.isFinite(options.deadlineAtMs) ? { deadlineAtMs: options.deadlineAtMs } : {}),
  };
}

function assertDeadline(deadlineAtMs: number | undefined): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new RepositoryCollectionError("RUN_TIMEOUT");
  }
}

function boundedLimit(value: number | undefined, approvedLimit: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return approvedLimit;
  }
  return Math.max(1, Math.min(approvedLimit, Math.floor(value)));
}

function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function mapCollectionError(error: unknown, fallback: CollectionErrorCode): RepositoryCollectionError {
  if (error instanceof RepositoryCollectionError) {
    return error;
  }
  if (!(error instanceof GitHubReadError)) {
    return new RepositoryCollectionError(fallback);
  }

  const code: CollectionErrorCode = error.code === "AUTHORIZATION_FAILED"
    ? "ACCESS_DENIED"
    : error.code === "DEFAULT_BRANCH_COMMIT_MISSING"
      ? "MISSING_COMMIT_METADATA"
      : error.code === "TREE_RETRIEVAL_FAILED"
        ? "TREE_RETRIEVAL_FAILED"
        : error.code === "BLOB_RETRIEVAL_FAILED"
          ? "FILE_RETRIEVAL_FAILED"
          : error.code === "SNAPSHOT_INCONSISTENT"
            ? "SNAPSHOT_INCONSISTENT"
            : error.code === "INVALID_RESPONSE"
              ? "INVALID_GITHUB_RESPONSE"
              : error.code === "REPOSITORY_NOT_FOUND" ||
                  error.code === "AUTHENTICATION_FAILED" ||
                  error.code === "RATE_LIMITED" ||
                  error.code === "NETWORK_FAILURE" ||
                  error.code === "SERVICE_UNAVAILABLE" ||
                  error.code === "CREDENTIAL_CONFIGURATION_INVALID" ||
                  error.code === "CREDENTIAL_STORE_UNAVAILABLE"
                ? error.code
                : fallback;
  return new RepositoryCollectionError(code, error.retryCount);
}