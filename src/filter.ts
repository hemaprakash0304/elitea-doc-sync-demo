import {
  MAX_COLLECTION_FILES,
  MAX_COLLECTION_FILE_BYTES,
  MAX_COLLECTION_TEXT_BYTES,
  TECHNICAL_PROFILE_PATH,
  type CollectedFile,
  type RepositoryCollectionResult,
} from "./collection.js";

export type SecretScannerId = "gitleaks" | "unavailable" | "test_double";
export type SecretScanState = "complete" | "incomplete" | "failed";
export type SecretSeverity = "low" | "medium" | "high" | "critical" | "unknown";

export type ScannerErrorCode =
  | "SCANNER_UNAVAILABLE"
  | "SCANNER_FAILED"
  | "SCAN_INCOMPLETE"
  | "INVALID_SCAN_RESULT"
  | "SCANNER_BOUNDARY_INVALID";

export interface SecretScanInputFile {
  path: string;
  content: string;
}

export interface SecretScanMatch {
  path: string;
  ruleId?: string;
  severity?: SecretSeverity;
  line?: number;
}

export interface SecretScanOutcome {
  status: SecretScanState;
  scannedFileCount: number;
  findings: SecretScanMatch[];
  errorCode?: ScannerErrorCode;
}

export interface SecretScanner {
  readonly id: SecretScannerId;
  readonly executionBoundary: "local";
  readonly version?: string;
  scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome>;
}

export class UnavailableSecretScanner implements SecretScanner {
  readonly id = "unavailable" as const;
  readonly executionBoundary = "local" as const;

  async scan(_files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    return {
      status: "failed",
      scannedFileCount: 0,
      findings: [],
      errorCode: "SCANNER_UNAVAILABLE",
    };
  }
}

export type FilterDisposition =
  | "included"
  | "excluded"
  | "omitted_due_to_limits"
  | "unreadable"
  | "sensitive"
  | "withheld";

export type FilterReason =
  | "sensitive_path"
  | "generated_or_dependency_path"
  | "log_cache_or_data_dump"
  | "unsupported_file_type"
  | "allowlisted_text"
  | "binary_file"
  | "symlink"
  | "submodule"
  | "unsupported_entry"
  | "invalid_path"
  | "file_size_limit"
  | "total_text_limit"
  | "file_count_limit"
  | "file_unavailable"
  | "invalid_text_size"
  | "secret_like_content"
  | "scan_incomplete";

export interface FilterRecord {
  path: string;
  disposition: FilterDisposition;
  reason: FilterReason;
}

export interface SanitizedSecurityFinding {
  path: string;
  category: "secret_like_content" | "existing_profile_secret";
  ruleId?: string;
  severity: SecretSeverity;
  action: "file_excluded" | "run_blocked";
}

export type ExistingProfileSafety =
  | { status: "absent" }
  | { status: "safe_to_parse" }
  | { status: "blocking_sensitive_finding" }
  | { status: "blocked_unavailable" };

export type FilterBlockingReason = ScannerErrorCode
  | "EXISTING_PROFILE_SECRET"
  | "EXISTING_PROFILE_UNAVAILABLE"
  | "COLLECTION_INCOMPLETE";

export interface FilteredAnalysisFile {
  path: string;
  extension: string | null;
  content: string;
  sourceCommitSha: string;
  blobSha: string | null;
}

export interface RepositoryFilterResult {
  status: "ready" | "partial" | "blocked";
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  analysisFiles: FilteredAnalysisFile[];
  exclusionRecords: FilterRecord[];
  fileRecords: FilterRecord[];
  securityFindings: SanitizedSecurityFinding[];
  scan: {
    status: SecretScanState;
    scanner: SecretScannerId;
    expectedFileCount: number;
    scannedFileCount: number;
    coverageComplete: boolean;
  };
  existingProfile: ExistingProfileSafety;
  blockingReason?: FilterBlockingReason;
}

export interface CandidateScanResult {
  status: "safe" | "blocked";
  scanStatus: SecretScanState;
  scanner: SecretScannerId;
  findings: SanitizedSecurityFinding[];
  blockingReason?: ScannerErrorCode | "CANDIDATE_SECRET_FOUND";
}

interface PendingFile {
  file: CollectedFile;
  path: string;
  size: number;
}

interface PathClassification {
  include: boolean;
  reason?: FilterReason;
}

const MAX_SAFE_RULE_ID_LENGTH = 64;
const SAFE_RULE_ID = /^[a-zA-Z0-9_.-]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SENSITIVE_FILE_NAMES = new Set([
  ".docker/config.json",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "authorized_keys",
  "known_hosts",
  "settings.xml",
]);
const SENSITIVE_EXTENSIONS = new Set([
  ".asc", ".cer", ".crt", ".der", ".gpg", ".jks", ".kdbx", ".key", ".keystore",
  ".p12", ".p7b", ".p7c", ".pem", ".p8", ".pfx", ".ppk",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".ai", ".apk", ".avi", ".bin", ".bmp", ".class", ".deb", ".dill",
  ".dll", ".dmg", ".doc", ".docx", ".dylib", ".ear", ".eps", ".exe", ".gif", ".gz",
  ".ico", ".iso", ".jar", ".jpeg", ".jpg", ".lib", ".msi", ".mov", ".mp3", ".mp4",
  ".o", ".pdf", ".png", ".ppt", ".pptx", ".psd", ".rpm", ".so", ".tar", ".tgz",
  ".tif", ".tiff", ".war", ".wav", ".webp", ".woff", ".woff2", ".xls", ".xlsx", ".zip",
]);
const OMITTED_EXTENSIONS = new Set([
  ".bak", ".cache", ".core", ".csv", ".db", ".dmp", ".dump", ".jsonl", ".log", ".old",
  ".sql.gz", ".sqlite", ".swap", ".tmp", ".trace", ".tsv",
]);
const GENERATED_DIRECTORY_NAMES = new Set([
  ".cache", ".gradle", ".next", ".nuxt", ".nyc_output", ".output", ".terraform", "bin", "bower_components",
  "build", "cache", "caches", "coverage", "dist", "external", "generated", "generated-resources",
  "generated-sources", "jspm_packages", "logs", "node_modules", "obj", "out", "pods", "target",
  "temp", "third-party", "third_party", "tmp", "vendor",
]);
const SENSITIVE_DIRECTORY_NAMES = new Set([
  ".aws", ".azure", ".kube", ".ssh", "credential", "credentials", "secret", "secrets",
]);
const ALLOWED_EXTENSIONS = new Set([
  ".adoc", ".cfg", ".conf", ".cjs", ".hcl", ".ini", ".java", ".js", ".jsx", ".md", ".mjs",
  ".properties", ".ps1", ".rst", ".sh", ".sql", ".toml", ".ts", ".tsx", ".tf", ".xml",
  ".yaml", ".yml", ".json",
]);
const ALLOWED_SPECIAL_FILES = new Set([
  "dockerfile",
  ".dockerignore",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pom.xml",
  "technical-profile.md",
  "yarn.lock",
]);

export async function filterRepositorySnapshot(
  collection: RepositoryCollectionResult,
  scanner: SecretScanner,
): Promise<RepositoryFilterResult> {
  const records = new Map<string, FilterRecord>();
  const pendingFiles: PendingFile[] = [];
  let coverageComplete = !collection.issues.some((issue) => issue.code === "FILE_COUNT_LIMIT");
  const rootProfile = collection.files.find((file) => file.path === TECHNICAL_PROFILE_PATH);
  const profileSnapshotConsistent = collection.existingProfile.profilePresent
    ? rootProfile !== undefined &&
      rootProfile.blobSha === collection.existingProfile.file.blobSha &&
      rootProfile.sourceCommitSha === collection.existingProfile.file.sourceCommitSha &&
      rootProfile.size === collection.existingProfile.file.size &&
      rootProfile.content === collection.existingProfile.file.content
    : rootProfile === undefined;

  for (const file of collection.files) {
    const safePath = normalizeRepositoryPath(file.path);
    if (safePath === undefined) {
      records.set(recordKey(file.path), { path: "[invalid-path]", disposition: "excluded", reason: "invalid_path" });
      continue;
    }

    const classification = classifyPath(safePath);
    if (!classification.include) {
      records.set(safePath, { path: safePath, disposition: "excluded", reason: classification.reason as FilterReason });
      continue;
    }

    if (file.kind === "symlink") {
      records.set(safePath, { path: safePath, disposition: "excluded", reason: "symlink" });
      continue;
    }
    if (file.kind === "submodule") {
      records.set(safePath, { path: safePath, disposition: "excluded", reason: "submodule" });
      continue;
    }
    if (file.kind !== "regular") {
      records.set(safePath, { path: safePath, disposition: "excluded", reason: "unsupported_entry" });
      continue;
    }
    if (file.contentStatus === "binary") {
      records.set(safePath, { path: safePath, disposition: "excluded", reason: "binary_file" });
      continue;
    }
    if (file.size > MAX_COLLECTION_FILE_BYTES || file.contentStatus === "file_size_limit") {
      records.set(safePath, { path: safePath, disposition: "omitted_due_to_limits", reason: "file_size_limit" });
      coverageComplete = false;
      continue;
    }
    if (file.contentStatus === "total_text_limit" || file.contentStatus === "file_count_limit") {
      records.set(safePath, {
        path: safePath,
        disposition: "omitted_due_to_limits",
        reason: file.contentStatus === "file_count_limit" ? "file_count_limit" : "total_text_limit",
      });
      coverageComplete = false;
      continue;
    }
    if (file.contentStatus !== "text" || file.content === undefined) {
      records.set(safePath, { path: safePath, disposition: "unreadable", reason: "file_unavailable" });
      coverageComplete = false;
      continue;
    }
    if (Buffer.byteLength(file.content, "utf8") !== file.size) {
      records.set(safePath, { path: safePath, disposition: "unreadable", reason: "invalid_text_size" });
      coverageComplete = false;
      continue;
    }

    pendingFiles.push({ file, path: safePath, size: file.size });
  }

  pendingFiles.sort((left, right) => compareText(left.path, right.path));
  const selectedFiles: PendingFile[] = [];
  let totalBytes = 0;
  for (const pending of pendingFiles) {
    if (selectedFiles.length >= MAX_COLLECTION_FILES) {
      records.set(pending.path, { path: pending.path, disposition: "omitted_due_to_limits", reason: "file_count_limit" });
      coverageComplete = false;
      continue;
    }
    if (totalBytes + pending.size > MAX_COLLECTION_TEXT_BYTES) {
      records.set(pending.path, { path: pending.path, disposition: "omitted_due_to_limits", reason: "total_text_limit" });
      coverageComplete = false;
      continue;
    }
    selectedFiles.push(pending);
    totalBytes += pending.size;
  }

  const scan = await executeScan(scanner, selectedFiles.map(({ file, path }) => ({
    path,
    content: file.content as string,
  })));
  const findings: SanitizedSecurityFinding[] = [];
  const analysisFiles: FilteredAnalysisFile[] = [];
  let profile: ExistingProfileSafety = collection.existingProfile.profilePresent || !profileSnapshotConsistent
    ? { status: "blocked_unavailable" }
    : { status: "absent" };
  let blockingReason: FilterBlockingReason | undefined = profileSnapshotConsistent
    ? undefined
    : "EXISTING_PROFILE_UNAVAILABLE";

  if (collection.existingProfile.profilePresent) {
    const profilePath = normalizeRepositoryPath(collection.existingProfile.file.path);
    const profileRecord = profilePath === undefined ? undefined : records.get(profilePath);
    if (
      profilePath !== TECHNICAL_PROFILE_PATH ||
      profileRecord?.disposition === "unreadable" ||
      profileRecord?.disposition === "omitted_due_to_limits" ||
      profileRecord?.disposition === "excluded" ||
      !selectedFiles.some(({ path }) => path === TECHNICAL_PROFILE_PATH)
    ) {
      profile = { status: "blocked_unavailable" };
      blockingReason = "EXISTING_PROFILE_UNAVAILABLE";
      coverageComplete = false;
    }
  }

  if (scan.status !== "complete") {
    blockingReason ??= scan.errorCode ?? (scan.status === "incomplete" ? "SCAN_INCOMPLETE" : "SCANNER_FAILED");
    for (const selected of selectedFiles) {
      records.set(selected.path, { path: selected.path, disposition: "withheld", reason: "scan_incomplete" });
    }
    if (collection.existingProfile.profilePresent) {
      profile = { status: "blocked_unavailable" };
    }
  } else {
    if (scan.scannedFileCount !== selectedFiles.length || !scan.validFindings) {
      blockingReason ??= scan.errorCode ?? "INVALID_SCAN_RESULT";
      for (const selected of selectedFiles) {
        records.set(selected.path, { path: selected.path, disposition: "withheld", reason: "scan_incomplete" });
      }
      if (collection.existingProfile.profilePresent) {
        profile = { status: "blocked_unavailable" };
      }
    } else {
      const matchedPaths = new Set(scan.findings.map((finding) => finding.path));
      for (const finding of scan.findings) {
        const isProfile = finding.path === TECHNICAL_PROFILE_PATH;
        findings.push({
          path: finding.path,
          category: isProfile ? "existing_profile_secret" : "secret_like_content",
          ...(finding.ruleId === undefined ? {} : { ruleId: finding.ruleId }),
          severity: finding.severity,
          action: isProfile ? "run_blocked" : "file_excluded",
        });
        records.set(finding.path, {
          path: finding.path,
          disposition: "sensitive",
          reason: "secret_like_content",
        });
        if (isProfile) {
          profile = { status: "blocking_sensitive_finding" };
          blockingReason = "EXISTING_PROFILE_SECRET";
        }
      }

      for (const selected of selectedFiles) {
        if (!matchedPaths.has(selected.path)) {
          records.set(selected.path, { path: selected.path, disposition: "included", reason: "allowlisted_text" });
          analysisFiles.push({
            path: selected.path,
            extension: selected.file.extension,
            content: selected.file.content as string,
            sourceCommitSha: selected.file.sourceCommitSha,
            blobSha: selected.file.blobSha,
          });
        }
      }

      if (
        collection.existingProfile.profilePresent && profileSnapshotConsistent &&
        profile.status !== "blocking_sensitive_finding"
      ) {
        profile = selectedFiles.some(({ path }) => path === TECHNICAL_PROFILE_PATH)
          ? { status: "safe_to_parse" }
          : { status: "blocked_unavailable" };
        if (profile.status === "blocked_unavailable") {
          blockingReason ??= "EXISTING_PROFILE_UNAVAILABLE";
        }
      }
    }
  }

  if (!coverageComplete && blockingReason === undefined) {
    blockingReason = "COLLECTION_INCOMPLETE";
  }
  findings.sort((left, right) => compareText(left.path, right.path));
  analysisFiles.sort((left, right) => compareText(left.path, right.path));
  const fileRecords = [...records.values()].sort((left, right) => compareText(left.path, right.path));
  const exclusionRecords = fileRecords.filter((record) => record.disposition !== "included");
  const hasSourceFindings = findings.some((finding) => finding.category === "secret_like_content");
  const status = blockingReason !== undefined
    ? "blocked"
    : hasSourceFindings
      ? "partial"
      : "ready";

  return {
    status,
    repositoryId: collection.repository.normalizedRepositoryId,
    defaultBranch: collection.defaultBranch,
    snapshotCommitSha: collection.snapshotCommitSha,
    analysisFiles: status === "blocked" ? [] : analysisFiles,
    exclusionRecords,
    fileRecords,
    securityFindings: findings,
    scan: {
      status: scan.status,
      scanner: scan.scanner,
      expectedFileCount: scan.expectedFileCount,
      scannedFileCount: scan.scannedFileCount,
      coverageComplete: coverageComplete && scan.status === "complete" && scan.validFindings,
    },
    existingProfile: profile,
    ...(blockingReason === undefined ? {} : { blockingReason }),
  };
}

export async function scanCandidateContent(
  content: string,
  scanner: SecretScanner,
): Promise<CandidateScanResult> {
  const scan = await executeScan(scanner, [{ path: TECHNICAL_PROFILE_PATH, content }]);
  if (scan.status !== "complete") {
    return {
      status: "blocked",
      scanStatus: scan.status,
      scanner: scan.scanner,
      findings: [],
      blockingReason: scan.errorCode ?? (scan.status === "incomplete" ? "SCAN_INCOMPLETE" : "SCANNER_FAILED"),
    };
  }
  if (scan.scannedFileCount !== 1 || !scan.validFindings) {
    return {
      status: "blocked",
      scanStatus: "failed",
      scanner: scan.scanner,
      findings: [],
      blockingReason: "INVALID_SCAN_RESULT",
    };
  }
  const findings = scan.findings.map((finding): SanitizedSecurityFinding => ({
    path: TECHNICAL_PROFILE_PATH,
    category: "secret_like_content",
    ...(finding.ruleId === undefined ? {} : { ruleId: finding.ruleId }),
    severity: finding.severity,
    action: "run_blocked",
  }));
  return findings.length === 0
    ? { status: "safe", scanStatus: "complete", scanner: scan.scanner, findings: [] }
    : { status: "blocked", scanStatus: "complete", scanner: scan.scanner, findings, blockingReason: "CANDIDATE_SECRET_FOUND" };
}

interface ExecutedScan {
  status: SecretScanState;
  scanner: SecretScannerId;
  expectedFileCount: number;
  scannedFileCount: number;
  findings: SanitizedSecretScanMatch[];
  validFindings: boolean;
  errorCode?: ScannerErrorCode;
}

interface SanitizedSecretScanMatch {
  path: string;
  ruleId?: string;
  severity: SecretSeverity;
  line?: number;
}

async function executeScan(
  scanner: SecretScanner,
  files: readonly SecretScanInputFile[],
): Promise<ExecutedScan> {
  let scannerId: SecretScannerId = "unavailable";
  try {
    if (scanner.executionBoundary !== "local") {
      return failedScan(files.length, scannerId, "SCANNER_BOUNDARY_INVALID");
    }
    scannerId = isScannerId(scanner.id) ? scanner.id : "unavailable";
    const outcome = await scanner.scan(files);
    if (!isScanState(outcome.status) || !Number.isSafeInteger(outcome.scannedFileCount) || outcome.scannedFileCount < 0) {
      return failedScan(files.length, scannerId, "INVALID_SCAN_RESULT");
    }
    if (outcome.status !== "complete") {
      const errorCode = isScannerErrorCode(outcome.errorCode)
        ? outcome.errorCode
        : outcome.status === "incomplete" ? "SCAN_INCOMPLETE" : "SCANNER_FAILED";
      return {
        status: outcome.status,
        scanner: scannerId,
        expectedFileCount: files.length,
        scannedFileCount: outcome.scannedFileCount,
        findings: [],
        validFindings: false,
        errorCode,
      };
    }
    if (!Array.isArray(outcome.findings)) {
      return failedScan(files.length, scannerId, "INVALID_SCAN_RESULT");
    }

    const inputPaths = new Set(files.map((file) => file.path));
    const sanitized: SanitizedSecretScanMatch[] = [];
    for (const finding of outcome.findings) {
      if (
        typeof finding !== "object" || finding === null ||
        typeof finding.path !== "string" || !inputPaths.has(finding.path)
      ) {
        return failedScan(files.length, scannerId, "INVALID_SCAN_RESULT");
      }
      const ruleId = sanitizeRuleId(finding.ruleId);
      if (finding.ruleId !== undefined && ruleId === undefined) {
        return failedScan(files.length, scannerId, "INVALID_SCAN_RESULT");
      }
      if (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1)) {
        return failedScan(files.length, scannerId, "INVALID_SCAN_RESULT");
      }
      if (finding.severity !== undefined && !isSeverity(finding.severity)) {
        return failedScan(files.length, scannerId, "INVALID_SCAN_RESULT");
      }
      sanitized.push({
        path: finding.path,
        ...(ruleId === undefined ? {} : { ruleId }),
        severity: finding.severity ?? "unknown",
        ...(finding.line === undefined ? {} : { line: finding.line }),
      });
    }
    if (outcome.scannedFileCount !== files.length) {
      return {
        status: "incomplete",
        scanner: scannerId,
        expectedFileCount: files.length,
        scannedFileCount: outcome.scannedFileCount,
        findings: [],
        validFindings: false,
        errorCode: "SCAN_INCOMPLETE",
      };
    }
    return {
      status: "complete",
      scanner: scannerId,
      expectedFileCount: files.length,
      scannedFileCount: outcome.scannedFileCount,
      findings: sanitized,
      validFindings: true,
    };
  } catch {
    return failedScan(files.length, scannerId, "SCANNER_FAILED");
  }
}

function failedScan(expectedFileCount: number, scanner: SecretScannerId, errorCode: ScannerErrorCode): ExecutedScan {
  return {
    status: "failed",
    scanner,
    expectedFileCount,
    scannedFileCount: 0,
    findings: [],
    validFindings: false,
    errorCode,
  };
}

function classifyPath(path: string): PathClassification {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const extension = extensionOf(basename);

  if (segments.some((segment) => segment === ".git" || segment === ".hg" || segment === ".svn" || segment === ".bzr") || basename === ".gitmodules") {
    return excluded("sensitive_path");
  }
  if (
    basename === ".env" || basename === ".envrc" || basename.startsWith(".env.") || basename.endsWith(".env") ||
    SENSITIVE_FILE_NAMES.has(basename) ||
    /^(?:credential|credentials|secret|secrets)(?:[._-].*)?$/.test(basename) ||
    segments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment)) ||
    segments.some((segment, index) => segment === ".config" && segments[index + 1] === "gcloud") ||
    /^id_(rsa|ed25519|ecdsa|dsa)(\.|$)/.test(basename) ||
    SENSITIVE_EXTENSIONS.has(extension) ||
    (segments.includes(".docker") && basename === "config.json")
  ) {
    return excluded("sensitive_path");
  }
  if (
    segments.some((segment) => GENERATED_DIRECTORY_NAMES.has(segment)) ||
    segments.some((segment, index) => segment === ".mvn" && segments[index + 1] === "wrapper" && segments[index + 2] === "dists")
  ) {
    return excluded("generated_or_dependency_path");
  }
  if (
    segments.some((segment) => ["log", "logs", "cache", "caches", "tmp", "temp", "backup", "backups", "dumps", "exports"].includes(segment)) ||
    [...OMITTED_EXTENSIONS].some((suffix) => normalized.endsWith(suffix)) ||
    basename.includes(".log") ||
    basename.startsWith(".~") || basename.endsWith("~") || basename.endsWith(".swp") || basename.endsWith(".swo")
  ) {
    return excluded("log_cache_or_data_dump");
  }
  if (BINARY_EXTENSIONS.has(extension) || basename.endsWith(".min.js") || basename.endsWith(".map")) {
    return excluded("binary_file");
  }
  if (!isAllowlistedPath(normalized, basename, extension)) {
    return excluded("unsupported_file_type");
  }
  return { include: true };
}

function isAllowlistedPath(path: string, basename: string, extension: string): boolean {
  if (
    ALLOWED_SPECIAL_FILES.has(basename) || basename.startsWith("dockerfile") ||
    /^readme/.test(basename) || /^(license|notice)(?:\.|$)/.test(basename)
  ) {
    return true;
  }
  if (extension === ".yml" || extension === ".yaml") {
    return true;
  }
  if (extension === ".js" && basename.endsWith(".min.js")) {
    return false;
  }
  if (extension === ".xml" && basename === "settings.xml") {
    return false;
  }
  if (path.startsWith(".github/workflows/") && (extension === ".yml" || extension === ".yaml")) {
    return true;
  }
  return ALLOWED_EXTENSIONS.has(extension);
}

function normalizeRepositoryPath(path: string): string | undefined {
  if (
    typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.includes("\\") ||
    CONTROL_CHARACTERS.test(path)
  ) {
    return undefined;
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return path;
}

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot);
}

function excluded(reason: FilterReason): PathClassification {
  return { include: false, reason };
}

function sanitizeRuleId(ruleId: unknown): string | undefined {
  if (ruleId === undefined) {
    return undefined;
  }
  if (
    typeof ruleId !== "string" || ruleId.length === 0 || ruleId.length > MAX_SAFE_RULE_ID_LENGTH ||
    !SAFE_RULE_ID.test(ruleId)
  ) {
    return undefined;
  }
  return ruleId;
}

function isScannerId(value: unknown): value is SecretScannerId {
  return value === "gitleaks" || value === "unavailable" || value === "test_double";
}

function isScanState(value: unknown): value is SecretScanState {
  return value === "complete" || value === "incomplete" || value === "failed";
}

function isScannerErrorCode(value: unknown): value is ScannerErrorCode {
  return value === "SCANNER_UNAVAILABLE" || value === "SCANNER_FAILED" || value === "SCAN_INCOMPLETE" ||
    value === "INVALID_SCAN_RESULT" || value === "SCANNER_BOUNDARY_INVALID";
}

function isSeverity(value: unknown): value is SecretSeverity {
  return value === "low" || value === "medium" || value === "high" || value === "critical" || value === "unknown";
}

function recordKey(path: string): string {
  return `[invalid:${path.length}]`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}