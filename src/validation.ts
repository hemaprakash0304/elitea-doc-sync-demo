import { createHash } from "node:crypto";
import { containsSensitiveValue } from "./analyzers/observation.js";
import type { EvidenceCatalogResult, EvidenceItem, ProfileSectionId } from "./evidence/types.js";
import { PROFILE_SECTIONS } from "./evidence/types.js";
import { scanCandidateContent, type CandidateScanResult, type SecretScanner } from "./filter.js";
import type { RepositoryFilterResult } from "./filter.js";
import type { ProfileCompositionResult } from "./composer.js";
import type { ProfileReconciliationResult, ReconciliationStatus } from "./reconciler.js";

export type ValidationStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export type ValidationCheckId =
  | "FILTERED_INPUT_SAFE"
  | "RECONCILIATION_COMPLETE"
  | "SNAPSHOT_BINDING"
  | "CANDIDATE_DIGEST"
  | "TEMPLATE_STRUCTURE"
  | "OWNERSHIP_BLOCKS"
  | "REQUIRED_FIELDS"
  | "EVIDENCE_INTEGRITY"
  | "COVERAGE_COMPLETENESS"
  | "STATUS_SEMANTICS"
  | "SECURITY_SCAN"
  | "SENSITIVE_CONTENT"
  | "DETERMINISTIC_OUTPUT"
  | "CHANGED_FILE_BOUNDARY"
  | "FAILURE_PRESERVATION";

export type ValidationIssueCode =
  | "FILTERED_INPUT_UNSAFE"
  | "RECONCILIATION_NOT_SUCCESSFUL"
  | "SNAPSHOT_MISMATCH"
  | "CANDIDATE_DIGEST_MISMATCH"
  | "SECTION_MISSING"
  | "SECTION_DUPLICATE"
  | "SECTION_ORDER_INVALID"
  | "UNEXPECTED_SECTION"
  | "GENERATED_MARKER_INVALID"
  | "SCHEMA_UNSUPPORTED"
  | "OWNERSHIP_MARKER_INVALID"
  | "OWNERSHIP_DIGEST_MISMATCH"
  | "TABLE_SCHEMA_INVALID"
  | "REQUIRED_FIELD_MISSING"
  | "EVIDENCE_ID_UNKNOWN"
  | "EVIDENCE_SNAPSHOT_MISMATCH"
  | "EVIDENCE_LOCATOR_UNSAFE"
  | "EVIDENCE_METADATA_INVALID"
  | "COVERAGE_ENTRY_MISSING"
  | "COVERAGE_ENTRY_DUPLICATE"
  | "STATUS_INVALID"
  | "STATUS_EVIDENCE_MISMATCH"
  | "UNSUPPORTED_CLAIM"
  | "SECRET_FOUND"
  | "SCANNER_FAILED"
  | "SCANNER_INCOMPLETE"
  | "SENSITIVE_VALUE_FOUND"
  | "NONDETERMINISTIC_FIELD"
  | "CHANGED_FILE_BOUNDARY"
  | "PROFILE_PRESERVATION_INVALID"
  | "NO_PROFILE_WRITE_ATTEMPTED";

export interface ValidationIssue {
  code: ValidationIssueCode;
  sectionId?: ProfileSectionId;
}

export interface ValidationCheckResult {
  id: ValidationCheckId;
  status: ValidationStatus;
  issues: ValidationIssue[];
}

export interface ValidationWarning {
  code: "CONFLICT_PRESENT" | "UNSUPPORTED_EVIDENCE" | "ANALYZER_ISSUE" | "PARTIAL_COVERAGE";
  count: number;
}

export interface ValidationResult {
  status: ValidationStatus;
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  candidateSha256?: string;
  schemaVersion: number;
  checks: ValidationCheckResult[];
  blockingFailures: ValidationIssue[];
  warnings: ValidationWarning[];
  diagnostics: ValidationIssue[];
  reconciliationStatus: ReconciliationStatus;
}

export interface ValidationInput {
  filtered: RepositoryFilterResult;
  catalog: EvidenceCatalogResult;
  composition: ProfileCompositionResult;
  reconciliation: ProfileReconciliationResult;
  scanner: SecretScanner;
  scannerTimeoutMs?: number;
}

type MarkdownRow = string[];

interface CandidateSection {
  id: ProfileSectionId;
  body: string;
  rows: MarkdownRow[];
}

const SECTION_TITLES: Readonly<Record<ProfileSectionId, string>> = {
  "01": "Application Name",
  "02": "Description",
  "03": "Primary Language / Runtime",
  "04": "Frameworks and Libraries",
  "05": "Dependencies",
  "06": "Database / Data Stores",
  "07": "APIs and Integrations",
  "08": "Configuration / Environment Variables",
  "09": "Build and Test",
  "10": "CI/CD",
  "11": "Deployment / Infrastructure",
  "12": "Security",
  "13": "Logging and Monitoring",
  "14": "Repository / Branch",
  "15": "Limitations / Missing Information",
  "16": "Evidence / Verification Status",
};
const SECTION_IDS = PROFILE_SECTIONS.map((section) => section.id);
const GLOBAL_MARKER = "<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->";
const STATUS_SET = new Set(["Verified", "Not Specified", "Unable to Verify", "Conflict"]);
const EVIDENCE_ID = /^E[0-9A-F]{64}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DRIVE_OR_MACHINE_PATH = /(?:\b[A-Za-z]:\\|\/(?:Users|home|tmp|private|var)\/)/;
const UUID_VALUE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

export async function validateReconciledCandidate(input: ValidationInput): Promise<ValidationResult> {
  const { filtered, catalog, composition, reconciliation } = input;
  const candidateSha256 = reconciliation.candidateSha256;
  const base = {
    repositoryId: filtered.repositoryId,
    defaultBranch: filtered.defaultBranch,
    snapshotCommitSha: filtered.snapshotCommitSha,
    ...(candidateSha256 === undefined ? {} : { candidateSha256 }),
    schemaVersion: composition.schemaVersion,
    reconciliationStatus: reconciliation.status,
  };
  const preflightIssue = validatePreflight(input);
  if (preflightIssue !== undefined) {
    const checks = blockedChecks(preflightIssue);
    return {
      ...base,
      status: "BLOCKED",
      checks,
      blockingFailures: [preflightIssue],
      warnings: validateWarnings(input),
      diagnostics: [preflightIssue],
    };
  }

  const candidate = reconciliation.candidate as string;
  const structureIssues = validateStructure(candidate, composition.schemaVersion);
  const ownershipIssues = validateCandidateOwnership(candidate);
  const tableIssues = validateTemplateTableStructure(candidate);
  const requiredRowIssues = validateRequiredRows(candidate);
  const evidenceIssues = [
    ...validateEvidenceReferences(candidate, catalog),
    ...validateEvidenceIds(candidate, catalog),
  ];
  const coverageIssues = validateCoverage(catalog);
  const statusIssues = [
    ...validateCandidateStatuses(candidate, catalog),
    ...validateUnsupportedClaims(candidate, catalog),
    ...validateDependencyVersions(candidate, catalog),
  ];
  const securityIssues = validateSensitiveContent(candidate);
  const deterministicIssues = validateDeterminism(candidate);
  const snapshotIssues = validateSnapshot(input);
  const digestIssues = [...validateDigests(input, candidate), ...validateCompositionCandidate(composition)];
  const boundaryIssues = validateChangedFileBoundary(reconciliation);
  const reconciliationIssues = validateReconciliationConsistency(reconciliation);
  const preservationIssues = validateFailurePreservation(input);

  let scannerResult: CandidateScanResult;
  try {
    scannerResult = await scanCandidateContent(candidate, input.scanner, input.scannerTimeoutMs);
  } catch {
    scannerResult = {
      status: "blocked",
      scanStatus: "failed",
      scanner: "unavailable",
      findings: [],
      blockingReason: "SCANNER_FAILED",
    };
  }
  const scannerIssues: ValidationIssue[] = scannerResult.status === "safe"
    ? []
    : [{ code: scannerResult.blockingReason === "CANDIDATE_SECRET_FOUND" ? "SECRET_FOUND" :
      scannerResult.blockingReason === "SCAN_INCOMPLETE" ? "SCANNER_INCOMPLETE" : "SCANNER_FAILED" }];

  const checks = [
    check("FILTERED_INPUT_SAFE", []),
    check("RECONCILIATION_COMPLETE", reconciliationIssues),
    check("SNAPSHOT_BINDING", snapshotIssues),
    check("CANDIDATE_DIGEST", digestIssues),
    check("TEMPLATE_STRUCTURE", structureIssues.filter((issue) => [
      "SECTION_MISSING", "SECTION_DUPLICATE", "SECTION_ORDER_INVALID", "UNEXPECTED_SECTION",
    ].includes(issue.code))),
    check("OWNERSHIP_BLOCKS", [
      ...structureIssues.filter((issue) => [
      "GENERATED_MARKER_INVALID", "SCHEMA_UNSUPPORTED", "OWNERSHIP_MARKER_INVALID", "OWNERSHIP_DIGEST_MISMATCH",
      ].includes(issue.code)),
      ...ownershipIssues,
    ]),
    check("REQUIRED_FIELDS", [
      ...structureIssues.filter((issue) => ["TABLE_SCHEMA_INVALID", "REQUIRED_FIELD_MISSING"].includes(issue.code)),
      ...tableIssues,
      ...requiredRowIssues,
    ]),
    check("EVIDENCE_INTEGRITY", evidenceIssues),
    check("COVERAGE_COMPLETENESS", coverageIssues),
    check("STATUS_SEMANTICS", statusIssues),
    check("SECURITY_SCAN", scannerIssues, scannerResult.status === "blocked" ? "BLOCKED" : undefined),
    check("SENSITIVE_CONTENT", securityIssues),
    check("DETERMINISTIC_OUTPUT", deterministicIssues),
    check("CHANGED_FILE_BOUNDARY", boundaryIssues),
    check("FAILURE_PRESERVATION", preservationIssues),
  ];
  const blockingFailures = checks.flatMap((item) => item.issues);
  const blocked = checks.some((item) => item.status === "BLOCKED");
  return {
    ...base,
    status: blocked ? "BLOCKED" : blockingFailures.length > 0 ? "FAIL" : "PASS",
    checks,
    blockingFailures,
    warnings: validateWarnings(input),
    diagnostics: [...blockingFailures],
  };
}

function validatePreflight(input: ValidationInput): ValidationIssue | undefined {
  const { filtered, catalog, composition, reconciliation } = input;
  if (
    filtered.status === "blocked" || filtered.scan.status !== "complete" || !filtered.scan.coverageComplete ||
    filtered.existingProfile.status === "blocking_sensitive_finding" || filtered.existingProfile.status === "blocked_unavailable"
  ) {
    return { code: "FILTERED_INPUT_UNSAFE" };
  }
  if (reconciliation.status === "BLOCKED" || reconciliation.status === "FAILED" || reconciliation.candidate === undefined) {
    return { code: "RECONCILIATION_NOT_SUCCESSFUL" };
  }
  if (
    filtered.repositoryId !== catalog.repositoryId || filtered.repositoryId !== composition.repositoryId ||
    filtered.repositoryId !== reconciliation.repositoryId ||
    filtered.defaultBranch !== catalog.defaultBranch || filtered.defaultBranch !== composition.defaultBranch ||
    filtered.defaultBranch !== reconciliation.defaultBranch ||
    filtered.snapshotCommitSha.toLowerCase() !== catalog.snapshotCommitSha.toLowerCase() ||
    filtered.snapshotCommitSha.toLowerCase() !== composition.snapshotCommitSha.toLowerCase() ||
    filtered.snapshotCommitSha.toLowerCase() !== reconciliation.snapshotCommitSha.toLowerCase()
  ) {
    return { code: "SNAPSHOT_MISMATCH" };
  }
  return undefined;
}

function blockedChecks(issue: ValidationIssue): ValidationCheckResult[] {
  return [
    check("FILTERED_INPUT_SAFE", issue.code === "FILTERED_INPUT_UNSAFE" ? [issue] : [], "BLOCKED"),
    check("RECONCILIATION_COMPLETE", issue.code === "RECONCILIATION_NOT_SUCCESSFUL" ? [issue] : [], "BLOCKED"),
    check("SNAPSHOT_BINDING", issue.code === "SNAPSHOT_MISMATCH" ? [issue] : [], "BLOCKED"),
    ...(["CANDIDATE_DIGEST", "TEMPLATE_STRUCTURE", "OWNERSHIP_BLOCKS", "REQUIRED_FIELDS", "EVIDENCE_INTEGRITY", "COVERAGE_COMPLETENESS", "STATUS_SEMANTICS", "SECURITY_SCAN", "SENSITIVE_CONTENT", "DETERMINISTIC_OUTPUT", "CHANGED_FILE_BOUNDARY", "FAILURE_PRESERVATION"] as ValidationCheckId[])
      .map((id) => check(id, [], "NOT_RUN")),
  ];
}

function validateStructure(candidate: string, schemaVersion: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (schemaVersion !== 1) {
    issues.push({ code: "SCHEMA_UNSUPPORTED" });
  }
  if (containsSensitiveContent(candidate)) {
    issues.push({ code: "SENSITIVE_VALUE_FOUND" });
  }
  const lines = splitLines(candidate);
  if (lines[0] !== "# Technical Profile" || lines.filter((line) => line === GLOBAL_MARKER).length !== 1) {
    issues.push({ code: "GENERATED_MARKER_INVALID" });
  }
  const headings = lines.filter((line) => line.startsWith("## "));
  const expectedHeadings = SECTION_IDS.map((id, index) => `## ${index + 1}. ${sectionTitle(id)}`);
  if (headings.length < expectedHeadings.length) {
    issues.push({ code: "SECTION_MISSING" });
  } else if (headings.length > expectedHeadings.length) {
    issues.push({ code: headings.some((heading, index) => headings.indexOf(heading) !== index) ? "SECTION_DUPLICATE" : "UNEXPECTED_SECTION" });
  } else if (headings.some((heading, index) => heading !== expectedHeadings[index])) {
    issues.push({ code: "SECTION_ORDER_INVALID" });
  }

  for (const sectionId of SECTION_IDS) {
    const sectionIssue = validateSectionBlock(candidate, sectionId);
    if (sectionIssue !== undefined) {
      issues.push(sectionIssue);
    }
  }
  return uniqueIssues(issues);
}

function validateSectionBlock(candidate: string, sectionId: ProfileSectionId): ValidationIssue | undefined {
  const startPattern = new RegExp(`^<!-- docs-sync:generated:start section=${sectionId} schema=(\\d+) sha256=([a-f0-9]{64}) -->$`, "gm");
  const endPattern = new RegExp(`^<!-- docs-sync:generated:end section=${sectionId} -->$`, "gm");
  const starts = [...candidate.matchAll(startPattern)];
  const ends = [...candidate.matchAll(endPattern)];
  if (starts.length !== 1 || ends.length !== 1) {
    return { code: "OWNERSHIP_MARKER_INVALID", sectionId };
  }
  const start = starts[0];
  const end = ends[0];
  if (start === undefined || end === undefined || start.index === undefined || end.index === undefined || start.index >= end.index) {
    return { code: "OWNERSHIP_MARKER_INVALID", sectionId };
  }
  if (Number(start[1]) !== 1) {
    return { code: "SCHEMA_UNSUPPORTED", sectionId };
  }
  const startLineEnd = candidate.indexOf("\n", start.index) + 1;
  const body = candidate.slice(startLineEnd, end.index);
  const digest = createHash("sha256").update(body.replace(/\r\n/g, "\n"), "utf8").digest("hex");
  if (digest !== start[2]) {
    return { code: "OWNERSHIP_DIGEST_MISMATCH", sectionId };
  }
  const rows = parseRows(body);
  const headers = sectionHeaders(sectionId);
  if (rows.length < 3 || rows[0]?.length !== headers.length || rows[0]?.some((value, index) => value !== headers[index])) {
    return { code: "TABLE_SCHEMA_INVALID", sectionId };
  }
  if (rows.some((row) => row.length !== headers.length)) {
    return { code: "TABLE_SCHEMA_INVALID", sectionId };
  }
  return undefined;
}

function validateEvidenceReferences(candidate: string, catalog: EvidenceCatalogResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const evidence = new Map(catalog.evidence.map((item) => [item.evidenceId, item]));
  const sections = parseCandidateSections(candidate);
  for (const section of sections) {
    const rows = section.rows.slice(2);
    for (const row of rows) {
      const statusIndex = section.id === "16" ? 5 : row.length - 2;
      const status = row[statusIndex];
      if (section.id === "16") {
        const id = row[0];
        if (id === "Not Specified") {
          continue;
        }
        if (id === undefined || !EVIDENCE_ID.test(id) || !evidence.has(id)) {
          issues.push({ code: "EVIDENCE_ID_UNKNOWN", sectionId: section.id });
          continue;
        }
        const item = evidence.get(id);
        if (item?.status !== status) {
          issues.push({ code: "STATUS_INVALID", sectionId: section.id });
        }
        if (!isSafeLocator(item?.sourceLocator)) {
          issues.push({ code: "EVIDENCE_LOCATOR_UNSAFE", sectionId: section.id });
        }
        if (item === undefined || item.evidenceId !== id) {
          issues.push({ code: "EVIDENCE_SNAPSHOT_MISMATCH", sectionId: section.id });
        }
        continue;
      }

      const evidenceCell = row[row.length - 1] ?? "";
      const ids = evidenceCell === "—" ? [] : evidenceCell.split(", ");
      for (const id of ids) {
        if (!EVIDENCE_ID.test(id) || !evidence.has(id)) {
          issues.push({ code: "EVIDENCE_ID_UNKNOWN", sectionId: section.id });
          continue;
        }
        const item = evidence.get(id);
        if (item === undefined || (item.sectionId !== section.id && section.id !== "15" && item.profileField !== "Unmapped")) {
          issues.push({ code: "EVIDENCE_SNAPSHOT_MISMATCH", sectionId: section.id });
          continue;
        }
        if (item.status !== status && status !== "Conflict") {
          issues.push({ code: "STATUS_INVALID", sectionId: section.id });
        }
        if (!isSafeLocator(item.sourceLocator)) {
          issues.push({ code: "EVIDENCE_LOCATOR_UNSAFE", sectionId: section.id });
        }
        if (!isKnownBasis(item.verificationBasis) || !isKnownConfidence(item.confidence)) {
          issues.push({ code: "EVIDENCE_METADATA_INVALID", sectionId: section.id });
        }
      }
    }
  }
  return uniqueIssues(issues);
}

function validateCoverage(catalog: EvidenceCatalogResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const section of PROFILE_SECTIONS) {
    const matches = catalog.coverage.filter((entry) => entry.sectionId === section.id && entry.profileField === section.field);
    if (matches.length !== 1) {
      issues.push({ code: matches.length === 0 ? "COVERAGE_ENTRY_MISSING" : "COVERAGE_ENTRY_DUPLICATE", sectionId: section.id });
    }
  }
  return uniqueIssues(issues);
}

function validateSensitiveContent(candidate: string): ValidationIssue[] {
  return validateCandidateSecurity(candidate);
}

function validateDeterminism(candidate: string): ValidationIssue[] {
  return validateDeterministicFields(candidate);
}

function validateSnapshot(input: ValidationInput): ValidationIssue[] {
  const expectedCommit = input.filtered.snapshotCommitSha.toLowerCase();
  const expectedRepository = input.filtered.repositoryId.toLowerCase();
  if (
    input.catalog.snapshotCommitSha.toLowerCase() !== expectedCommit ||
    input.composition.snapshotCommitSha.toLowerCase() !== expectedCommit ||
    input.reconciliation.snapshotCommitSha.toLowerCase() !== expectedCommit ||
    input.catalog.repositoryId.toLowerCase() !== expectedRepository ||
    input.composition.repositoryId.toLowerCase() !== expectedRepository ||
    input.reconciliation.repositoryId.toLowerCase() !== expectedRepository ||
    input.catalog.defaultBranch !== input.filtered.defaultBranch ||
    input.composition.defaultBranch !== input.filtered.defaultBranch ||
    input.reconciliation.defaultBranch !== input.filtered.defaultBranch
  ) {
    return [{ code: "SNAPSHOT_MISMATCH" }];
  }
  return [];
}

function validateDigests(input: ValidationInput, candidate: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const digest = sha256(candidate);
  if (digest !== input.reconciliation.candidateSha256?.toLowerCase()) {
    issues.push({ code: "CANDIDATE_DIGEST_MISMATCH" });
  }
  const composedDigest = sha256(input.composition.candidate);
  if (composedDigest !== input.composition.candidateSha256.toLowerCase()) {
    issues.push({ code: "CANDIDATE_DIGEST_MISMATCH" });
  }
  return issues;
}

function validateChangedFileBoundary(reconciliation: ProfileReconciliationResult): ValidationIssue[] {
  if (reconciliation.candidate === undefined || typeof reconciliation.candidate !== "string") {
    return [{ code: "CHANGED_FILE_BOUNDARY" }];
  }
  if (reconciliation.status === "NO_CHANGES" &&
    (reconciliation.additions.length > 0 || reconciliation.modifications.length > 0 || reconciliation.removals.length > 0)) {
    return [{ code: "CHANGED_FILE_BOUNDARY" }];
  }
  return [];
}

function validateFailurePreservation(input: ValidationInput): ValidationIssue[] {
  const profileWasPresent = input.filtered.existingProfile.status !== "absent";
  if (input.reconciliation.existingProfilePreserved !== profileWasPresent) {
    return [{ code: "PROFILE_PRESERVATION_INVALID" }];
  }
  if (input.reconciliation.status === "NO_CHANGES" && input.reconciliation.candidate !== undefined &&
    input.reconciliation.candidateSha256 !== sha256(input.reconciliation.candidate)) {
    return [{ code: "PROFILE_PRESERVATION_INVALID" }];
  }
  return [];
}

function validateTemplateTableStructure(candidate: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const section of parseCandidateSections(candidate)) {
    const headers = sectionHeaders(section.id);
    const rows = section.rows;
    if (rows.length < 3 || rows[0]?.length !== headers.length || rows[0]?.some((cell, index) => cell !== headers[index])) {
      issues.push({ code: "TABLE_SCHEMA_INVALID", sectionId: section.id });
      continue;
    }
    if (rows.some((row) => row.length !== headers.length)) {
      issues.push({ code: "TABLE_SCHEMA_INVALID", sectionId: section.id });
    }
    if (section.id === "08") {
      for (const row of rows.slice(2)) {
        const variable = row[0] ?? "";
        if (variable !== "Not Specified" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
          issues.push({ code: "UNSUPPORTED_CLAIM", sectionId: section.id });
        }
      }
    }
  }
  return issues;
}

function validateUnsupportedClaims(candidate: string, catalog: EvidenceCatalogResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const forbiddenClaims = [
    /\b(?:production|deployed|actual)\s+(?:node(?:\.js)?|java|jdk)\s+(?:runtime|version)\b/i,
    /\b(?:workflow|action)\s+(?:successfully\s+)?(?:passed|succeeded|completed successfully)\b/i,
    /\b(?:running|live)\s+(?:database|container|service|deployment)\b/i,
  ];
  for (const pattern of forbiddenClaims) {
    if (pattern.test(candidate) && !/not established|not verified|unable to verify/i.test(candidate)) {
      issues.push({ code: "UNSUPPORTED_CLAIM" });
      break;
    }
  }

  const dependencyRows = parseCandidateSections(candidate).find((section) => section.id === "05")?.rows.slice(2) ?? [];
  const evidence = new Map(catalog.evidence.map((item) => [item.evidenceId, item]));
  for (const row of dependencyRows) {
    const resolved = row[3] ?? "";
    const ids = (row.at(-1) ?? "—") === "—" ? [] : (row.at(-1) ?? "").split(", ");
    const lockVersions = ids.map((id) => evidence.get(id)).filter((item): item is EvidenceItem => item?.sourceType === "package_lockfile").map((item) => item.fact.value);
    if (resolved !== "Not Specified" && resolved !== "Unable to Verify" && !lockVersions.includes(resolved)) {
      issues.push({ code: "UNSUPPORTED_CLAIM", sectionId: "05" });
    }
  }
  return uniqueIssues(issues);
}

function validateCompositionCandidate(composition: ProfileCompositionResult): ValidationIssue[] {
  if (
    composition.schemaVersion !== 1 || !/^[0-9a-f]{40}$/i.test(composition.snapshotCommitSha) ||
    sha256(composition.candidate) !== composition.candidateSha256.toLowerCase()
  ) {
    return [{ code: "CANDIDATE_DIGEST_MISMATCH" }];
  }
  return [];
}

function validateReconciliationConsistency(reconciliation: ProfileReconciliationResult): ValidationIssue[] {
  if (reconciliation.status === "BLOCKED" || reconciliation.status === "FAILED") {
    return [{ code: "RECONCILIATION_NOT_SUCCESSFUL" }];
  }
  const changes = [...reconciliation.additions, ...reconciliation.modifications, ...reconciliation.removals];
  const changeGroups = [reconciliation.additions, reconciliation.modifications, reconciliation.removals];
  if (changeGroups.some((group) => stableJson(group) !== stableJson(sortChanges([...group])))) {
    return [{ code: "RECONCILIATION_NOT_SUCCESSFUL" }];
  }
  if (reconciliation.status === "NO_CHANGES" && changes.length > 0) {
    return [{ code: "RECONCILIATION_NOT_SUCCESSFUL" }];
  }
  return [];
}

function validateRequiredRows(candidate: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const section of parseCandidateSections(candidate)) {
    const rowKeys = section.rows.slice(2).map((row) => row[0] ?? "");
    const required: Partial<Record<ProfileSectionId, readonly string[]>> = {
      "01": ["Application Name"],
      "02": ["Description"],
      "03": ["Primary language", "Runtime(s)"],
      "09": ["Build tool", "Build command(s)", "Test framework", "Test command(s)"],
      "14": ["Repository", "Default branch", "Analyzed commit/ref"],
    };
    if (required[section.id]?.some((field) => !rowKeys.includes(field))) {
      issues.push({ code: "REQUIRED_FIELD_MISSING", sectionId: section.id });
    }
    const requiredKeys = required[section.id] ?? [];
    if (requiredKeys.some((field) => rowKeys.filter((key) => key === field).length !== 1)) {
      issues.push({ code: "TABLE_SCHEMA_INVALID", sectionId: section.id });
    }
  }
  return issues;
}

function validateCandidateOwnership(candidate: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (candidate.split(GLOBAL_MARKER).length !== 2) {
    issues.push({ code: "GENERATED_MARKER_INVALID" });
  }
  const sections = parseCandidateSections(candidate);
  if (sections.length !== SECTION_IDS.length) {
    issues.push({ code: sections.length < SECTION_IDS.length ? "SECTION_MISSING" : "SECTION_DUPLICATE" });
  }
  for (const sectionId of SECTION_IDS) {
    const startMatches = [...candidate.matchAll(new RegExp(`^<!-- docs-sync:generated:start section=${sectionId} schema=(\\d+) sha256=([a-f0-9]{64}) -->$`, "gm"))];
    const endMatches = [...candidate.matchAll(new RegExp(`^<!-- docs-sync:generated:end section=${sectionId} -->$`, "gm"))];
    if (startMatches.length !== 1 || endMatches.length !== 1) {
      issues.push({ code: "OWNERSHIP_MARKER_INVALID", sectionId });
      continue;
    }
    const start = startMatches[0];
    const end = endMatches[0];
    if (start?.index === undefined || end?.index === undefined || start.index >= end.index || Number(start[1]) !== 1) {
      issues.push({ code: "OWNERSHIP_MARKER_INVALID", sectionId });
      continue;
    }
    const bodyStart = candidate.indexOf("\n", start.index) + 1;
    const body = candidate.slice(bodyStart, end.index);
    if (sha256(body) !== start[2]) {
      issues.push({ code: "OWNERSHIP_DIGEST_MISMATCH", sectionId });
    }
  }
  return uniqueIssues(issues);
}

function validateEvidenceIds(candidate: string, catalog: EvidenceCatalogResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const known = new Map(catalog.evidence.map((item) => [item.evidenceId, item]));
  for (const section of parseCandidateSections(candidate)) {
    for (const row of section.rows.slice(2)) {
      const cell = section.id === "16" ? row[0] ?? "" : row.at(-1) ?? "—";
      if (cell === "—" || cell === "Not Specified") {
        continue;
      }
      const ids = cell.split(", ");
      for (const evidenceId of ids) {
        if (!EVIDENCE_ID.test(evidenceId) || !known.has(evidenceId)) {
          issues.push({ code: "EVIDENCE_ID_UNKNOWN", sectionId: section.id });
          continue;
        }
        const item = known.get(evidenceId);
        if (item === undefined || !isSafeLocator(item.sourceLocator)) {
          issues.push({ code: "EVIDENCE_LOCATOR_UNSAFE", sectionId: section.id });
        }
        if (item !== undefined && item.confidence !== "High" && item.confidence !== "Medium" && item.confidence !== "Low") {
          issues.push({ code: "EVIDENCE_METADATA_INVALID", sectionId: section.id });
        }
        if (item !== undefined && item.sectionId !== section.id && section.id !== "15" && section.id !== "16" && item.profileField !== "Unmapped") {
          issues.push({ code: "EVIDENCE_SNAPSHOT_MISMATCH", sectionId: section.id });
        }
      }
    }
  }
  return uniqueIssues(issues);
}

function validateCandidateStatuses(candidate: string, catalog: EvidenceCatalogResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const evidenceById = new Map(catalog.evidence.map((item) => [item.evidenceId, item]));
  const coverageBySection = new Map(catalog.coverage.map((entry) => [entry.sectionId, entry]));
  for (const section of parseCandidateSections(candidate)) {
    for (const row of section.rows.slice(2)) {
      const status = row[section.id === "16" ? 5 : row.length - 2] ?? "";
      if (!STATUS_SET.has(status)) {
        issues.push({ code: "STATUS_INVALID", sectionId: section.id });
        continue;
      }
      const factCells = section.id === "16" ? row.slice(1, 5) : row.slice(0, row.length - 2);
      const factText = factCells.join(" ");
      const idCell = section.id === "16" ? row[0] ?? "" : row.at(-1) ?? "—";
      const ids = idCell === "—" || idCell === "Not Specified" ? [] : idCell.split(", ");
      const referenced = ids.map((id) => evidenceById.get(id)).filter((item): item is EvidenceItem => item !== undefined);
      if (section.id === "16") {
        if (referenced.length !== 1 || referenced[0]?.status !== status) {
          issues.push({ code: "STATUS_EVIDENCE_MISMATCH", sectionId: section.id });
        }
        continue;
      }
      if (status === "Verified" && !referenced.some((item) => item.status === "Verified")) {
        issues.push({ code: "STATUS_EVIDENCE_MISMATCH", sectionId: section.id });
      }
      if (status === "Not Specified" && !factText.includes("Not Specified") &&
        !/No eligible (?:repository )?evidence was found/i.test(factText)) {
        issues.push({ code: "STATUS_EVIDENCE_MISMATCH", sectionId: section.id });
      }
      if (status === "Unable to Verify" && referenced.length === 0 &&
        coverageBySection.get(section.id)?.status !== "unable_to_verify" &&
        (coverageBySection.get(section.id)?.issues.length ?? 0) === 0 &&
        !/not established|unavailable|excluded|incomplete|unable to verify/i.test(factText)) {
        issues.push({ code: "STATUS_EVIDENCE_MISMATCH", sectionId: section.id });
      }
      if (status === "Conflict" && (referenced.length < 2 ||
        !referenced.some((item) => item.status === "Conflict" || item.authorityRelation === "peer_conflict" || item.authorityRelation === "overridden_by_authority"))) {
        issues.push({ code: "STATUS_EVIDENCE_MISMATCH", sectionId: section.id });
      }
    }
  }
  return uniqueIssues(issues);
}

function validateCandidateSecurity(candidate: string): ValidationIssue[] {
  return containsSensitiveContent(candidate) ? [{ code: "SENSITIVE_VALUE_FOUND" }] : [];
}

function validateDeterministicFields(candidate: string): ValidationIssue[] {
  const nondeterministic = [
    /^\s*(?:generated at|created at|timestamp)\s*:/im,
    /\b(?:run|process)[-_ ]?id\s*:\s*[0-9a-f]{8}-[0-9a-f-]{27,}/i,
    UUID_VALUE,
    DRIVE_OR_MACHINE_PATH,
  ];
  return nondeterministic.some((pattern) => pattern.test(candidate)) ? [{ code: "NONDETERMINISTIC_FIELD" }] : [];
}

function validateDependencyVersions(candidate: string, catalog: EvidenceCatalogResult): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(catalog.evidence.map((item) => [item.evidenceId, item]));
  const dependencies = parseCandidateSections(candidate).find((section) => section.id === "05")?.rows.slice(2) ?? [];
  for (const row of dependencies) {
    const resolvedVersion = row[3] ?? "Not Specified";
    const ids = (row.at(-1) ?? "—") === "—" ? [] : (row.at(-1) ?? "").split(", ");
    const resolvedEvidenceValues = ids.map((id) => byId.get(id))
      .filter((item): item is EvidenceItem => item?.sourceType === "package_lockfile")
      .map((item) => item.fact.value);
    if (resolvedVersion !== "Not Specified" && resolvedVersion !== "Unable to Verify" && !resolvedEvidenceValues.includes(resolvedVersion)) {
      issues.push({ code: "UNSUPPORTED_CLAIM", sectionId: "05" });
    }
  }
  return issues;
}

function validateWarnings(input: ValidationInput): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  const conflictCount = input.catalog.evidence.filter((item) => item.status === "Conflict").length;
  const unsupportedCount = input.catalog.evidence.filter((item) => item.profileField === "Limitations / Missing Information" && item.status === "Unable to Verify").length;
  if (conflictCount > 0) warnings.push({ code: "CONFLICT_PRESENT", count: conflictCount });
  if (unsupportedCount > 0) warnings.push({ code: "UNSUPPORTED_EVIDENCE", count: unsupportedCount });
  if (input.catalog.issues.length > 0) warnings.push({ code: "ANALYZER_ISSUE", count: input.catalog.issues.length });
  if (input.filtered.status === "partial") warnings.push({ code: "PARTIAL_COVERAGE", count: 1 });
  return warnings.sort((left, right) => compareText(left.code, right.code));
}

function parseCandidateSections(candidate: string): CandidateSection[] {
  const lines = splitLines(candidate);
  const headings = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("## "));
  const sections: CandidateSection[] = [];
  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    if (current === undefined) continue;
    const id = SECTION_IDS[index];
    if (id === undefined) continue;
    const next = headings[index + 1];
    const sectionLines = lines.slice(current.index + 1, next?.index ?? lines.length);
    const start = sectionLines.findIndex((line) => new RegExp(`^<!-- docs-sync:generated:start section=${id} `).test(line));
    const end = sectionLines.findIndex((line) => line === `<!-- docs-sync:generated:end section=${id} -->`);
    if (start < 0 || end <= start) continue;
    const body = sectionLines.slice(start + 1, end).join("\n");
    sections.push({ id, body, rows: parseRows(body) });
  }
  return sections;
}

function parseRows(body: string): string[][] {
  return body.split("\n").filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map(parseMarkdownRow);
}

function parseMarkdownRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === undefined) continue;
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(decodeCell(cell));
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(decodeCell(cell));
  return cells;
}

function decodeCell(cell: string): string {
  return cell.trim()
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"");
}

function sectionHeaders(sectionId: ProfileSectionId): readonly string[] {
  const section = PROFILE_SECTIONS.find((entry) => entry.id === sectionId);
  switch (section?.id) {
    case "01":
    case "02":
    case "03":
    case "14": return ["Field", "Value", "Status", "Evidence IDs"];
    case "04": return ["Framework/Library", "Declared or observed version", "Status", "Evidence IDs"];
    case "05": return ["Dependency", "Scope", "Declared version/specifier", "Lockfile-resolved version", "Status", "Evidence IDs"];
    case "06": return ["Technology", "Repository evidence/role", "Status", "Evidence IDs"];
    case "07": return ["API/Integration", "Observed repository reference", "Status", "Evidence IDs"];
    case "08": return ["Variable name", "Evidence-backed purpose, if specified", "Status", "Evidence IDs"];
    case "09": return ["Category", "Tool/framework/command", "Status", "Evidence IDs"];
    case "10": return ["Workflow/job/trigger/step", "Repository declaration", "Status", "Evidence IDs"];
    case "11": return ["Declared component/resource", "Repository declaration", "Status", "Evidence IDs"];
    case "12": return ["Observed security configuration/control", "Repository declaration", "Status", "Evidence IDs"];
    case "13": return ["Library/configuration/reference", "Repository declaration", "Status", "Evidence IDs"];
    case "15": return ["Limitation or missing field", "Safe explanation", "Status", "Evidence IDs"];
    case "16": return ["Evidence ID", "Profile field", "Source type", "Sanitized source locator", "Extracted fact (sanitized)", "Status", "Verification basis", "Confidence"];
  }
  return [];
}

function sectionTitle(sectionId: ProfileSectionId): string {
  return SECTION_TITLES[sectionId];
}

function isKnownBasis(basis: EvidenceItem["verificationBasis"]): boolean {
  return basis === "structured_declaration" || basis === "manifest_declaration" || basis === "lockfile_resolution" ||
    basis === "direct_source_pattern" || basis === "documentation_claim" || basis === "unsupported_technology_mention" ||
    basis === "github_repository_metadata" || basis === "filtering_policy";
}

function isKnownConfidence(confidence: EvidenceItem["confidence"]): boolean {
  return confidence === "High" || confidence === "Medium" || confidence === "Low";
}

function isSafeLocator(locator: string | undefined): boolean {
  return locator !== undefined && locator.length > 0 && !CONTROL_CHARACTERS.test(locator) &&
    !containsSensitiveContent(locator) && !DRIVE_OR_MACHINE_PATH.test(locator);
}

function containsSensitiveContent(value: string): boolean {
  return containsSensitiveValue(value) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value);
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split("\n");
}

function check(id: ValidationCheckId, issues: ValidationIssue[], forceStatus?: ValidationStatus): ValidationCheckResult {
  return { id, status: forceStatus ?? (issues.length === 0 ? "PASS" : "FAIL"), issues: [...issues] };
}

function uniqueIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const unique = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    unique.set(`${issue.code}\0${issue.sectionId ?? ""}`, issue);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.sectionId ?? "99", right.sectionId ?? "99") || compareText(left.code, right.code),
  );
}

function sortChanges<T extends { sectionId: ProfileSectionId; rowKey: string }>(changes: readonly T[]): T[] {
  return [...changes].sort((left, right) => compareText(left.sectionId, right.sectionId) || compareText(left.rowKey, right.rowKey));
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}