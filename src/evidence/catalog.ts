import { createHash } from "node:crypto";
import { containsSensitiveValue } from "../analyzers/observation.js";
import type {
  AnalyzerIssue,
  ObservationConfidence,
  ObservationStatus,
  TechnicalObservation,
  VerificationBasis,
} from "../analyzers/types.js";
import type { RepositoryFilterResult } from "../filter.js";
import {
  authorityForSource,
  authorityRank,
  mapObservation,
  sectionIdFor,
  sourceTypeForObservation,
} from "./mapping.js";
import {
  PROFILE_SECTIONS,
  type AuthorityRelation,
  type CatalogIssue,
  type CoverageEntry,
  type CoverageIssueCode,
  type CoverageStatus,
  type EvidenceAuthority,
  type EvidenceCatalogResult,
  type EvidenceFact,
  type EvidenceItem,
  type EvidenceSourceType,
  type ProfileField,
  type ProfileSectionId,
} from "./types.js";
import type { TechnologyAnalysisResult } from "../analyzers/types.js";

const OBSERVATION_STATUSES = new Set<ObservationStatus>([
  "Verified", "Not Specified", "Unable to Verify", "Conflict",
]);
const CONFIDENCES = new Set<ObservationConfidence>(["High", "Medium", "Low"]);
const ANALYZER_IDS = new Set(["java_maven", "javascript_node", "docker", "github_actions", "documentation"]);
const SOURCE_KINDS = new Set(["manifest", "lockfile", "source", "configuration", "workflow", "dockerfile", "documentation"]);
const CLAIM_TYPES = new Set(["declaration", "source_reference", "documentation_claim"]);
const VERIFICATION_BASES = new Set([
  "structured_declaration", "manifest_declaration", "lockfile_resolution", "direct_source_pattern",
  "documentation_claim", "unsupported_technology_mention",
]);
const OBSERVATION_CATEGORIES = new Set([
  "project_coordinate", "java_language_level", "maven_wrapper_version", "dependency", "build_plugin",
  "build_command", "test_command", "java_package", "java_import", "configuration_variable",
  "configuration_reference", "infrastructure_resource", "package_name", "package_description",
  "node_engine_constraint", "package_script", "test_tool", "node_module_reference", "docker_base_image",
  "docker_build_stage", "docker_exposed_port", "docker_build_command", "docker_environment_variable",
  "docker_build_argument", "docker_ignore_pattern", "compose_service", "compose_volume", "compose_network",
  "compose_port", "compose_environment_variable", "workflow_name", "workflow_trigger", "workflow_job",
  "github_action", "workflow_permission", "workflow_step", "workflow_environment_variable",
  "documentation_technology_claim", "unsupported_technology", "documented_command",
]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DRIVE_PATH = /^[A-Za-z]:\//;

export type EvidenceCatalogErrorCode = "SNAPSHOT_MISMATCH" | "UNSAFE_FILTERED_INPUT";

export class EvidenceCatalogError extends Error {
  readonly code: EvidenceCatalogErrorCode;

  constructor(code: EvidenceCatalogErrorCode) {
    super(code === "SNAPSHOT_MISMATCH"
      ? "Evidence inputs do not refer to the same immutable repository snapshot."
      : "Evidence catalog requires a safe, completely scanned filtered snapshot.");
    this.name = "EvidenceCatalogError";
    this.code = code;
  }
}

export interface EvidenceCatalogMetadata {
  repositoryFullName: string;
}

interface CandidateEvidence {
  evidenceId: string;
  snapshotCommitSha: string;
  sectionId: ProfileSectionId | null;
  profileField: ProfileField;
  fieldKey: string;
  sourceType: EvidenceSourceType;
  sourceLocator: string;
  fact: EvidenceFact;
  status: ObservationStatus;
  verificationBasis: VerificationBasis | "github_repository_metadata" | "filtering_policy";
  confidence: ObservationConfidence;
  authority: EvidenceAuthority;
  authorityRelation: AuthorityRelation;
  conflictsWith: string[];
  originalStatus: ObservationStatus;
}

export function buildEvidenceCatalog(
  filtered: RepositoryFilterResult,
  analysis: TechnologyAnalysisResult,
  metadata: EvidenceCatalogMetadata,
): EvidenceCatalogResult {
  assertSafeMatchingSnapshot(filtered, analysis, metadata.repositoryFullName);
  const catalogIssues: CatalogIssue[] = [];
  const candidates: CandidateEvidence[] = [];

  candidates.push(...createMetadataEvidence(
    filtered.snapshotCommitSha,
    filtered.defaultBranch,
    metadata.repositoryFullName,
  ));

  for (const observation of analysis.observations) {
    const candidate = normalizeObservation(observation, filtered.snapshotCommitSha);
    if (candidate === "sensitive") {
      const analyzer = safeAnalyzerId(observation);
      catalogIssues.push({ code: "SENSITIVE_OBSERVATION_DROPPED", ...(analyzer === undefined ? {} : { analyzer }) });
    } else if (candidate === undefined) {
      const analyzer = safeAnalyzerId(observation);
      catalogIssues.push({ code: "MALFORMED_OBSERVATION", ...(analyzer === undefined ? {} : { analyzer }) });
    } else {
      candidates.push(candidate);
    }
  }

  const unique = deduplicateCandidates(candidates);
  markConflicts(unique);
  const evidence = unique.map(toEvidenceItem).sort(compareEvidence);
  const coverageIssues = createCoverageIssues(filtered, analysis.issues, evidence, catalogIssues);
  const coverage = buildCoverage(evidence, coverageIssues);

  return {
    repositoryId: filtered.repositoryId,
    defaultBranch: filtered.defaultBranch,
    snapshotCommitSha: filtered.snapshotCommitSha,
    evidence,
    coverage,
    issues: uniqueCatalogIssues(catalogIssues),
  };
}

function assertSafeMatchingSnapshot(
  filtered: RepositoryFilterResult,
  analysis: TechnologyAnalysisResult,
  repositoryFullName: string,
): void {
  if (
    filtered.status === "blocked" ||
    filtered.scan.status !== "complete" ||
    !filtered.scan.coverageComplete ||
    filtered.existingProfile.status === "blocking_sensitive_finding" ||
    filtered.existingProfile.status === "blocked_unavailable"
  ) {
    throw new EvidenceCatalogError("UNSAFE_FILTERED_INPUT");
  }
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryFullName.trim()) ||
    containsSensitiveValue(repositoryFullName) || containsSensitiveValue(filtered.defaultBranch) ||
    !/^[0-9a-f]{40}$/i.test(filtered.snapshotCommitSha)
  ) {
    throw new EvidenceCatalogError("UNSAFE_FILTERED_INPUT");
  }
  if (
    filtered.repositoryId !== analysis.repositoryId ||
    filtered.defaultBranch !== analysis.defaultBranch ||
    filtered.snapshotCommitSha.toLowerCase() !== analysis.snapshotCommitSha.toLowerCase() ||
    repositoryFullName.trim().toLowerCase() !== filtered.repositoryId.toLowerCase()
  ) {
    throw new EvidenceCatalogError("SNAPSHOT_MISMATCH");
  }
}

function createMetadataEvidence(
  snapshotCommitSha: string,
  defaultBranch: string,
  repositoryFullName: string,
): CandidateEvidence[] {
  const metadataFacts = [
    {
      profileField: "Application Name" as const,
      fieldKey: "application_name",
      name: "Repository name",
      value: repositoryFullName,
      locator: "repository.full_name",
    },
    {
      profileField: "Repository / Branch" as const,
      fieldKey: "repository.full_name",
      name: "Repository",
      value: repositoryFullName,
      locator: "repository.full_name",
    },
    {
      profileField: "Repository / Branch" as const,
      fieldKey: "repository.default_branch",
      name: "Default branch",
      value: defaultBranch,
      locator: "repository.default_branch",
    },
    {
      profileField: "Repository / Branch" as const,
      fieldKey: "repository.analyzed_commit",
      name: "Analyzed commit/ref",
      value: snapshotCommitSha.toLowerCase(),
      locator: "git.commit.sha",
    },
  ];
  return metadataFacts.map((fact) => createCandidate({
    snapshotCommitSha,
    sectionId: sectionIdFor(fact.profileField),
    profileField: fact.profileField,
    fieldKey: fact.fieldKey,
    sourceType: "github_metadata",
    sourceLocator: `GitHub repository metadata:${fact.locator}`,
    fact: { name: fact.name, value: normalizeText(fact.value) },
    status: "Verified",
    verificationBasis: "github_repository_metadata",
    confidence: "High",
    authority: "github_metadata",
    authorityRelation: "authoritative",
    originalStatus: "Verified",
  }));
}

function normalizeObservation(
  observation: TechnicalObservation,
  snapshotCommitSha: string,
): CandidateEvidence | "sensitive" | undefined {
  if (
    typeof observation !== "object" || observation === null ||
    typeof observation.name !== "string" || typeof observation.value !== "string" ||
    typeof observation.source !== "object" || observation.source === null ||
    typeof observation.source.path !== "string" || typeof observation.source.locator !== "string" ||
    !ANALYZER_IDS.has(observation.analyzer) || !OBSERVATION_CATEGORIES.has(observation.category) ||
    !SOURCE_KINDS.has(observation.source.kind) || !CLAIM_TYPES.has(observation.claimType) ||
    !VERIFICATION_BASES.has(observation.verificationBasis) ||
    !OBSERVATION_STATUSES.has(observation.status) || !CONFIDENCES.has(observation.confidence)
  ) {
    return undefined;
  }

  const path = normalizePath(observation.source.path);
  const locator = normalizeLocator(observation.source.locator);
  const name = normalizeText(observation.name);
  const value = normalizeText(observation.value);
  const attributes = normalizeAttributes(observation.attributes);
  if (path === undefined || locator === undefined || name.length === 0 || value.length === 0 || attributes === undefined) {
    return undefined;
  }
  if ([path, locator, name, value, ...Object.keys(attributes), ...Object.values(attributes)].some(containsSensitiveValue)) {
    return "sensitive";
  }

  const mapping = mapObservation(observation);
  const sourceType = sourceTypeForObservation(observation);
  const authority = authorityForSource(sourceType);
  const fieldKey = mapping.sectionId === null
    ? `unmapped:${observation.category}:${normalizeKey(name)}`
    : mapping.fieldKey;
  let status = observation.status;
  if (observation.confidence === "Low" && status === "Verified") {
    status = "Unable to Verify";
  }
  if (observation.category === "unsupported_technology") {
    status = "Unable to Verify";
  }

  return createCandidate({
    snapshotCommitSha,
    sectionId: mapping.sectionId,
    profileField: mapping.profileField,
    fieldKey,
    sourceType,
    sourceLocator: `${path}#${locator}`,
    fact: { name, value, ...(Object.keys(attributes).length === 0 ? {} : { attributes }) },
    status,
    verificationBasis: observation.verificationBasis,
    confidence: observation.confidence,
    authority,
    authorityRelation: mapping.sectionId === null ? "unmapped" :
      authority === "lockfile" || authority === "github_metadata" ? "authoritative" : "supporting",
    originalStatus: status,
  });
}

function createCandidate(
  input: Omit<CandidateEvidence, "evidenceId" | "conflictsWith">,
): CandidateEvidence {
  const identity = {
    snapshotCommitSha: input.snapshotCommitSha.toLowerCase(),
    sectionId: input.sectionId,
    profileField: input.profileField,
    fieldKey: input.fieldKey,
    sourceType: input.sourceType,
    sourceLocator: input.sourceLocator,
    fact: input.fact,
    status: input.originalStatus,
    verificationBasis: input.verificationBasis,
    confidence: input.confidence,
    authority: input.authority,
  };
  const evidenceId = `E${createHash("sha256").update(stableJson(identity), "utf8").digest("hex").toUpperCase()}`;
  return { ...input, evidenceId, conflictsWith: [] };
}

function deduplicateCandidates(candidates: readonly CandidateEvidence[]): CandidateEvidence[] {
  const unique = new Map<string, CandidateEvidence>();
  for (const candidate of candidates) {
    unique.set(candidate.evidenceId, candidate);
  }
  return [...unique.values()].sort(compareEvidence);
}

function markConflicts(candidates: CandidateEvidence[]): void {
  const groups = new Map<string, CandidateEvidence[]>();
  for (const candidate of candidates) {
    if (candidate.sectionId === null || candidate.profileField === "Unmapped") {
      continue;
    }
    const key = `${candidate.sectionId}\0${candidate.fieldKey}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const distinctFacts = new Set(group.map((item) => stableJson(item.fact)));
    if (distinctFacts.size < 2) {
      continue;
    }
    const maxRank = Math.max(...group.map((item) => authorityRank(item.authority)));
    const authoritative = group.filter((item) => authorityRank(item.authority) === maxRank);
    const authoritativeFacts = new Set(authoritative.map((item) => stableJson(item.fact)));
    if (authoritativeFacts.size === 1 && authoritative.some((item) => item.status === "Verified")) {
      const winnerIds = authoritative.filter((item) => item.status === "Verified").map((item) => item.evidenceId).sort(compareText);
      const lowerIds = group.filter((item) => !winnerIds.includes(item.evidenceId)).map((item) => item.evidenceId).sort(compareText);
      for (const item of authoritative) {
        item.authorityRelation = "authoritative";
        item.conflictsWith = lowerIds;
      }
      for (const item of group) {
        if (winnerIds.includes(item.evidenceId)) {
          continue;
        }
        item.status = "Conflict";
        item.authorityRelation = "overridden_by_authority";
        item.conflictsWith = winnerIds;
      }
      continue;
    }

    for (const item of group) {
      item.status = "Conflict";
      item.authorityRelation = "peer_conflict";
      item.conflictsWith = group.filter((other) => other.evidenceId !== item.evidenceId)
        .map((other) => other.evidenceId)
        .sort(compareText);
    }
  }
}

function toEvidenceItem(candidate: CandidateEvidence): EvidenceItem {
  return {
    evidenceId: candidate.evidenceId,
    sectionId: candidate.sectionId,
    profileField: candidate.profileField,
    fieldKey: candidate.fieldKey,
    sourceType: candidate.sourceType,
    sourceLocator: candidate.sourceLocator,
    fact: candidate.fact,
    status: candidate.status,
    verificationBasis: candidate.verificationBasis,
    confidence: candidate.confidence,
    authority: candidate.authority,
    authorityRelation: candidate.authorityRelation,
    conflictsWith: [...candidate.conflictsWith].sort(compareText),
  };
}

function createCoverageIssues(
  filtered: RepositoryFilterResult,
  analyzerIssues: readonly AnalyzerIssue[],
  evidence: readonly EvidenceItem[],
  catalogIssues: CatalogIssue[],
): Map<ProfileSectionId, Map<CoverageIssueCode, number>> {
  const issues = new Map<ProfileSectionId, Map<CoverageIssueCode, number>>();
  const add = (section: ProfileSectionId, code: CoverageIssueCode, count = 1) => {
    const sectionIssues = issues.get(section) ?? new Map<CoverageIssueCode, number>();
    sectionIssues.set(code, (sectionIssues.get(code) ?? 0) + count);
    issues.set(section, sectionIssues);
  };

  for (const record of filtered.fileRecords) {
    if (record.disposition === "included") {
      continue;
    }
    const mapped = sectionsForPath(record.path);
    if (mapped.length === 0) {
      if (record.disposition === "sensitive" || record.reason === "sensitive_path" || record.reason === "secret_like_content") {
        add("15", "SENSITIVE_SOURCE_EXCLUDED");
      }
      continue;
    }
    const code: CoverageIssueCode = record.disposition === "sensitive" || record.reason === "sensitive_path" ||
      record.reason === "secret_like_content"
      ? "SENSITIVE_SOURCE_EXCLUDED"
      : record.disposition === "unreadable"
        ? "UNREADABLE_SOURCE"
        : record.disposition === "omitted_due_to_limits" || record.disposition === "withheld"
          ? "SOURCE_LIMIT_EXCEEDED"
          : "EXCLUDED_SOURCE";
    for (const section of mapped) {
      add(section, code);
    }
  }

  for (const finding of filtered.securityFindings) {
    for (const section of sectionsForPath(finding.path)) {
      add(section, "SENSITIVE_SOURCE_EXCLUDED");
    }
    add("15", "SENSITIVE_SOURCE_EXCLUDED");
  }

  for (const issue of analyzerIssues) {
    const affected = issue.path.length === 0 ? sectionsForAnalyzer(issue.analyzer) : sectionsForPath(issue.path);
    for (const section of affected) {
      add(section, issue.code === "ANALYZER_FAILED" ? "ANALYZER_FAILED" : "ANALYZER_INPUT_INVALID");
    }
    add("15", issue.code === "ANALYZER_FAILED" ? "ANALYZER_FAILED" : "ANALYZER_INPUT_INVALID");
    const analyzer = safeAnalyzerId(issue);
    const path = safePath(issue.path);
    catalogIssues.push({
      code: "ANALYZER_ISSUE",
      ...(analyzer === undefined ? {} : { analyzer }),
      ...(path === undefined ? {} : { path }),
    });
  }

  const unmappedCount = evidence.filter((item) => item.profileField === "Unmapped").length;
  if (unmappedCount > 0) {
    add("15", "UNMAPPED_OBSERVATION", unmappedCount);
  }
  if (!filtered.scan.coverageComplete) {
    for (const section of PROFILE_SECTIONS) {
      add(section.id, "SCAN_COVERAGE_INCOMPLETE");
    }
  }
  for (const issue of catalogIssues) {
    if (issue.code === "MALFORMED_OBSERVATION" || issue.code === "SENSITIVE_OBSERVATION_DROPPED") {
      add("15", "UNMAPPED_OBSERVATION");
    }
  }
  return issues;
}

function buildCoverage(
  evidence: readonly EvidenceItem[],
  issueMap: Map<ProfileSectionId, Map<CoverageIssueCode, number>>,
): CoverageEntry[] {
  return PROFILE_SECTIONS.map((section): CoverageEntry => {
    let entries = evidence.filter((item) => item.sectionId === section.id);
    if (section.id === "15") {
      entries = evidence.filter((item) => item.sectionId === "15" || item.profileField === "Unmapped");
    } else if (section.id === "16") {
      entries = [...evidence];
    }
    const ids = entries.map((item) => item.evidenceId).sort(compareText);
    const verifiedEvidenceIds = entries.filter((item) => item.status === "Verified").map((item) => item.evidenceId).sort(compareText);
    const conflictingEvidenceIds = entries.filter((item) => item.status === "Conflict").map((item) => item.evidenceId).sort(compareText);
    const unverifiableEvidenceIds = entries.filter((item) => item.status === "Unable to Verify").map((item) => item.evidenceId).sort(compareText);
    const sectionIssues = issueMap.get(section.id) ?? new Map<CoverageIssueCode, number>();
    const coverageIssues = [...sectionIssues.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([code, count]) => ({ code, count }));

    let status: CoverageStatus;
    if (section.id === "16" && entries.length > 0) {
      status = "supported_by_verified_evidence";
    } else if (conflictingEvidenceIds.length > 0) {
      status = "supported_by_conflicting_evidence";
    } else if (verifiedEvidenceIds.length > 0) {
      status = "supported_by_verified_evidence";
    } else if (unverifiableEvidenceIds.length > 0 || coverageIssues.length > 0) {
      status = "unable_to_verify";
    } else {
      status = "not_specified";
    }

    return {
      sectionId: section.id,
      profileField: section.field,
      status,
      evidenceIds: ids,
      verifiedEvidenceIds,
      conflictingEvidenceIds,
      unverifiableEvidenceIds,
      issues: coverageIssues,
    };
  });
}

function sectionsForPath(path: string): ProfileSectionId[] {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === "technical-profile.md") {
    return [];
  }
  if (base === ".env" || base.startsWith(".env.") || base.endsWith(".env")) {
    return ["08"];
  }
  if (lower.startsWith(".github/workflows/")) {
    return ["08", "10", "11", "12"];
  }
  if (base === "pom.xml") {
    return ["01", "03", "04", "05", "09"];
  }
  if (base === "package.json") {
    return ["01", "02", "03", "04", "05", "09"];
  }
  if (["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"].includes(base)) {
    return ["05"];
  }
  if (/\.java$/.test(lower)) {
    return ["03", "04", "07", "13"];
  }
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(lower)) {
    return ["03", "04", "07", "08", "13"];
  }
  if (base.startsWith("dockerfile") || base === ".dockerignore" || /^(?:docker-)?compose.*\.ya?ml$/.test(base)) {
    return ["08", "09", "11"];
  }
  if (/\.sql(?:\.gz)?$/.test(lower)) {
    return ["06"];
  }
  if (/\.(?:tf|hcl)$/.test(lower)) {
    return ["11"];
  }
  if (/^(?:readme|license|notice)/.test(base) || /\.(?:md|rst|adoc)$/.test(lower)) {
    return ["01", "02", "03", "04", "06", "07", "09", "11", "12", "13", "15"];
  }
  if (/\.(?:json|ya?ml|toml|xml|properties|ini|cfg|conf)$/.test(lower)) {
    return ["03", "04", "06", "07", "08", "09", "11", "12", "13"];
  }
  return [];
}

function sectionsForAnalyzer(analyzer: string): ProfileSectionId[] {
  switch (analyzer) {
    case "java_maven": return ["01", "03", "04", "05", "09"];
    case "javascript_node": return ["01", "02", "03", "04", "05", "09"];
    case "docker": return ["08", "09", "11"];
    case "github_actions": return ["08", "10", "11", "12"];
    case "documentation": return ["01", "02", "03", "04", "06", "07", "09", "11", "12", "13", "15"];
    default: return [];
  }
}

function normalizePath(path: string): string | undefined {
  const raw = path.normalize("NFC").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
  const segments = raw.split("/").filter((segment) => segment !== ".");
  const normalized = segments.join("/");
  if (
    normalized.length === 0 || normalized.startsWith("/") || DRIVE_PATH.test(normalized) ||
    CONTROL_CHARACTERS.test(normalized) || segments.some((segment) => segment === ".." || segment === "")
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeLocator(locator: string): string | undefined {
  const normalized = normalizeText(locator).replace(/^line:0*(\d+)$/i, (_match, line: string) => `line:${Number(line)}`);
  if (normalized.length === 0 || CONTROL_CHARACTERS.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function normalizeAttributes(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const pairs: [string, string][] = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") {
      return undefined;
    }
    const key = normalizeText(rawKey);
    const normalizedValue = normalizeText(rawValue);
    if (key.length > 0 && normalizedValue.length > 0) {
      pairs.push([key, normalizedValue]);
    }
  }
  pairs.sort(([left], [right]) => compareText(left, right));
  return Object.fromEntries(pairs);
}

function safePath(path: string): string | undefined {
  const normalized = normalizePath(path);
  return normalized !== undefined && !containsSensitiveValue(normalized) ? normalized : undefined;
}

function safeAnalyzerId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null &&
    "analyzer" in value && typeof value.analyzer === "string" &&
    /^[a-z_]+$/.test(value.analyzer) ? value.analyzer : undefined;
}

function uniqueCatalogIssues(issues: readonly CatalogIssue[]): CatalogIssue[] {
  const unique = new Map<string, CatalogIssue>();
  for (const issue of issues) {
    unique.set(`${issue.code}\0${issue.analyzer ?? ""}\0${issue.path ?? ""}`, issue);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.code, right.code) || compareText(left.analyzer ?? "", right.analyzer ?? "") || compareText(left.path ?? "", right.path ?? ""),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([left], [right]) => compareText(left, right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareEvidence(left: CandidateEvidence | EvidenceItem, right: CandidateEvidence | EvidenceItem): number {
  return compareText(left.sectionId ?? "99", right.sectionId ?? "99") ||
    compareText(left.fieldKey, right.fieldKey) ||
    authorityRank(right.authority) - authorityRank(left.authority) ||
    compareText(left.sourceLocator, right.sourceLocator) ||
    compareText(left.sourceType, right.sourceType) ||
    compareText(left.fact.name, right.fact.name) ||
    compareText(left.fact.value, right.fact.value) ||
    compareText(left.evidenceId, right.evidenceId);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}