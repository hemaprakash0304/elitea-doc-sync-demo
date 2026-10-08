import { createHash } from "node:crypto";
import { containsSensitiveValue } from "./analyzers/observation.js";
import {
  PROFILE_SECTIONS,
  type CoverageEntry,
  type CoverageStatus,
  type EvidenceCatalogResult,
  type EvidenceItem,
  type ProfileSection,
  type ProfileSectionId,
} from "./evidence/types.js";

export const PROFILE_SCHEMA_VERSION = 1;
export const AUTOMATIC_PROFILE_MARKER = "<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->";

export type ProfileComposerErrorCode = "INVALID_COVERAGE" | "UNSAFE_EVIDENCE" | "INVALID_EVIDENCE_CATALOG" | "INVALID_TABLE_STRUCTURE";

export class ProfileComposerError extends Error {
  readonly code: ProfileComposerErrorCode;

  constructor(code: ProfileComposerErrorCode) {
    super(code === "UNSAFE_EVIDENCE"
      ? "Profile composition found evidence that cannot be emitted safely."
      : code === "INVALID_COVERAGE"
        ? "Profile composition requires all 16 DEC-05 coverage entries in order."
        : code === "INVALID_TABLE_STRUCTURE"
          ? "Profile composition could not produce a stable table structure."
        : "Profile composition requires a consistent evidence catalog.");
    this.name = "ProfileComposerError";
    this.code = code;
  }
}

export interface ProfileCompositionResult {
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  candidate: string;
  candidateSha256: string;
  sectionDigests: Readonly<Record<ProfileSectionId, string>>;
}

interface TableRow {
  cells: string[];
  status: string;
  evidenceIds: string[];
}

export function composeTechnicalProfile(catalog: EvidenceCatalogResult): ProfileCompositionResult {
  assertCatalog(catalog);
  const sectionDigests = {} as Record<ProfileSectionId, string>;
  const output = [
    "# Technical Profile",
    "",
    AUTOMATIC_PROFILE_MARKER,
  ];

  for (const section of PROFILE_SECTIONS) {
    const tableBody = renderSectionTable(section, catalog);
    const digest = sha256(tableBody);
    sectionDigests[section.id] = digest;
    output.push(
      "",
      `## ${Number(section.id)}. ${section.field}`,
      `<!-- docs-sync:generated:start section=${section.id} schema=${PROFILE_SCHEMA_VERSION} sha256=${digest} -->`,
      tableBody.trimEnd(),
      `<!-- docs-sync:generated:end section=${section.id} -->`,
    );
  }

  const candidate = `${output.join("\n")}\n`;
  if (containsSensitiveValue(candidate)) {
    throw new ProfileComposerError("UNSAFE_EVIDENCE");
  }
  return {
    repositoryId: catalog.repositoryId,
    defaultBranch: catalog.defaultBranch,
    snapshotCommitSha: catalog.snapshotCommitSha,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    candidate,
    candidateSha256: sha256(candidate),
    sectionDigests,
  };
}

function assertCatalog(catalog: EvidenceCatalogResult): void {
  if (
    typeof catalog !== "object" || catalog === null ||
    typeof catalog.repositoryId !== "string" || typeof catalog.defaultBranch !== "string" ||
    !/^[0-9a-f]{40}$/i.test(catalog.snapshotCommitSha) ||
    !Array.isArray(catalog.evidence) || !Array.isArray(catalog.coverage) || !Array.isArray(catalog.issues)
  ) {
    throw new ProfileComposerError("INVALID_EVIDENCE_CATALOG");
  }
  if (
    catalog.coverage.length !== PROFILE_SECTIONS.length ||
    catalog.coverage.some((coverage, index) => {
      const expected = PROFILE_SECTIONS[index];
      return expected === undefined || coverage.sectionId !== expected.id || coverage.profileField !== expected.field;
    })
  ) {
    throw new ProfileComposerError("INVALID_COVERAGE");
  }

  const evidenceIds = new Set<string>();
  for (const item of catalog.evidence) {
    if (
      typeof item.evidenceId !== "string" || !/^E[0-9A-F]{64}$/.test(item.evidenceId) ||
      evidenceIds.has(item.evidenceId) || typeof item.sourceLocator !== "string" ||
      typeof item.fact?.name !== "string" || typeof item.fact.value !== "string"
    ) {
      throw new ProfileComposerError("INVALID_EVIDENCE_CATALOG");
    }
    evidenceIds.add(item.evidenceId);
    const values = [
      item.sourceLocator,
      item.fact.name,
      item.fact.value,
      ...Object.keys(item.fact.attributes ?? {}),
      ...Object.values(item.fact.attributes ?? {}),
    ];
    if (values.some(containsSensitiveValue)) {
      throw new ProfileComposerError("UNSAFE_EVIDENCE");
    }
  }

  for (const coverage of catalog.coverage) {
    if (
      !isCoverageStatus(coverage.status) ||
      coverage.evidenceIds.some((evidenceId) => !evidenceIds.has(evidenceId))
    ) {
      throw new ProfileComposerError("INVALID_EVIDENCE_CATALOG");
    }
  }
}

function renderSectionTable(section: ProfileSection, catalog: EvidenceCatalogResult): string {
  switch (section.id) {
    case "01": return renderStandardTable(["Field", "Value", "Status", "Evidence IDs"],
      singleValueRows(catalog, section.id, "Application Name"));
    case "02": return renderStandardTable(["Field", "Value", "Status", "Evidence IDs"],
      singleValueRows(catalog, section.id, "Description"));
    case "03": return renderStandardTable(["Field", "Value", "Status", "Evidence IDs"], renderRuntimeRows(catalog, section.id));
    case "04": return renderStandardTable(["Framework/Library", "Declared or observed version", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "05": return renderStandardTable(
      ["Dependency", "Scope", "Declared version/specifier", "Lockfile-resolved version", "Status", "Evidence IDs"],
      renderDependencyRows(catalog, section.id),
    );
    case "06": return renderStandardTable(["Technology", "Repository evidence/role", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "07": return renderStandardTable(["API/Integration", "Observed repository reference", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "08": return renderStandardTable(["Variable name", "Evidence-backed purpose, if specified", "Status", "Evidence IDs"],
      renderEnvironmentRows(catalog, section.id));
    case "09": return renderStandardTable(["Category", "Tool/framework/command", "Status", "Evidence IDs"],
      renderBuildTestRows(catalog, section.id));
    case "10": return renderStandardTable(["Workflow/job/trigger/step", "Repository declaration", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "11": return renderStandardTable(["Declared component/resource", "Repository declaration", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "12": return renderStandardTable(["Observed security configuration/control", "Repository declaration", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "13": return renderStandardTable(["Library/configuration/reference", "Repository declaration", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "14": return renderStandardTable(["Field", "Value", "Status", "Evidence IDs"],
      renderFactRows(catalog, section.id, (item) => [displayName(item), item.fact.value]));
    case "15": return renderStandardTable(["Limitation or missing field", "Safe explanation", "Status", "Evidence IDs"],
      renderLimitations(catalog));
    case "16": return renderEvidenceLedger(catalog);
  }
}

function singleValueRows(catalog: EvidenceCatalogResult, section: ProfileSectionId, rowName: string): TableRow[] {
  const evidence = evidenceForSection(catalog, section).filter((item) => item.fieldKey ===
    (section === "01" ? "application_name" : "description"));
  if (evidence.length === 0) {
    return [placeholderRow([rowName, "Not Specified"], emptyFieldStatus(catalog, section))];
  }
  const distinctValues = new Set(evidence.map((item) => item.fact.value));
  if (distinctValues.size > 1 || evidence.some((item) => item.status === "Conflict")) {
    return [row(
      [rowName, "Conflicting evidence; see Evidence / Verification Status"],
      "Conflict",
      evidence.map((item) => item.evidenceId),
    )];
  }
  return evidence.map((item) => row([rowName, item.fact.value], item.status, [item.evidenceId]));
}

function renderRuntimeRows(catalog: EvidenceCatalogResult, section: ProfileSectionId): TableRow[] {
  const evidence = evidenceForSection(catalog, section);
  const language: TableRow[] = [];
  const runtimes: TableRow[] = [];
  for (const item of evidence) {
    if (item.fieldKey.startsWith("java_language_level:")) {
      language.push(row(
        ["Primary language", `Java source/release configuration (${item.fact.name}): ${item.fact.value}`],
        item.status,
        [item.evidenceId],
      ));
    } else if (item.fieldKey.startsWith("documented_technology:")) {
      const name = item.fact.value;
      language.push(row(["Primary language", `${name} (documented claim)`], item.status, [item.evidenceId]));
    } else if (item.fieldKey.startsWith("node_engine_constraint:")) {
      runtimes.push(row(
        ["Runtime(s)", `Declared Node.js engine constraint: ${item.fact.value}; deployed runtime not established`],
        item.status,
        [item.evidenceId],
      ));
    } else {
      runtimes.push(row(["Runtime(s)", `${item.fact.name}: ${item.fact.value}`], item.status, [item.evidenceId]));
    }
  }
  return [
    ...(language.length === 0 ? [placeholderRow(["Primary language", "Not Specified"], emptyFieldStatus(catalog, section))] : language),
    ...(runtimes.length === 0
      ? [placeholderRow(["Runtime(s)", "Not Specified"], language.length > 0 ? "Unable to Verify" : emptyFieldStatus(catalog, section))]
      : runtimes),
  ];
}

function renderDependencyRows(catalog: EvidenceCatalogResult, section: ProfileSectionId): TableRow[] {
  const evidence = evidenceForSection(catalog, section);
  if (evidence.length === 0) {
    return [placeholderRow(["Not Specified", "Not Specified", "Not Specified", "Not Specified"], emptyFieldStatus(catalog, section))];
  }

  const byDependency = new Map<string, { declared: EvidenceItem[]; resolved: EvidenceItem[] }>();
  for (const item of evidence) {
    const group = byDependency.get(item.fact.name) ?? { declared: [], resolved: [] };
    if (item.fieldKey.endsWith(":resolved") || item.sourceType === "package_lockfile") {
      group.resolved.push(item);
    } else {
      group.declared.push(item);
    }
    byDependency.set(item.fact.name, group);
  }

  const rows: TableRow[] = [];
  for (const dependency of [...byDependency.keys()].sort(compareText)) {
    const group = byDependency.get(dependency);
    if (group === undefined) {
      continue;
    }
    const declared = sortEvidence(group.declared);
    const resolved = sortEvidence(group.resolved);
    if (declared.length > 0 && resolved.length > 0) {
      for (const declaration of declared) {
        for (const resolution of resolved) {
          rows.push(dependencyRow(dependency, declaration, resolution));
        }
      }
    } else if (declared.length > 0) {
      rows.push(...declared.map((item) => dependencyRow(dependency, item, undefined)));
    } else {
      rows.push(...resolved.map((item) => dependencyRow(dependency, undefined, item)));
    }
  }
  return rows;
}

function dependencyRow(dependency: string, declared?: EvidenceItem, resolved?: EvidenceItem): TableRow {
  const sources = [declared, resolved].filter((item): item is EvidenceItem => item !== undefined);
  const scope = declared?.fact.attributes?.scope ?? "Not Specified";
  const declaredVersion = declared?.status === "Unable to Verify"
    ? "Unable to Verify"
    : declared?.fact.value ?? "Not Specified";
  const resolvedVersion = resolved?.fact.value ?? "Not Specified";
  return row(
    [dependency, scope, declaredVersion, resolvedVersion],
    combinedStatus(sources),
    sources.map((item) => item.evidenceId),
  );
}

function renderEnvironmentRows(catalog: EvidenceCatalogResult, section: ProfileSectionId): TableRow[] {
  const environmentEvidence = evidenceForSection(catalog, section)
    .filter((item) => item.fieldKey.startsWith("environment_variable:"));
  const byName = new Map<string, EvidenceItem[]>();
  for (const item of environmentEvidence) {
    const name = item.fact.value;
    const entries = byName.get(name) ?? [];
    entries.push(item);
    byName.set(name, entries);
  }
  if (byName.size === 0) {
    return [placeholderRow(["Not Specified", "Not Specified"], emptyFieldStatus(catalog, section))];
  }
  return [...byName.entries()].sort(([left], [right]) => compareText(left, right)).map(([name, items]) =>
    row([name, "Not Specified"], combinedStatus(items), items.map((item) => item.evidenceId)),
  );
}

function renderBuildTestRows(catalog: EvidenceCatalogResult, section: ProfileSectionId): TableRow[] {
  const entries = evidenceForSection(catalog, section);
  const rows: TableRow[] = [];
  for (const item of entries) {
    const key = item.fieldKey.split(":", 1)[0] ?? "";
    const category = key === "test_command" || key === "test_tool"
      ? key === "test_tool" ? "Test framework" : "Test command(s)"
      : key === "documented_command"
        ? "Documented command"
        : key === "maven_wrapper_version" || key === "build_plugin"
          ? "Build tool"
          : key === "build_command"
            ? "Build command(s)"
            : "Build/Test declaration";
    const value = key === "build_plugin" || key === "maven_wrapper_version"
      ? `${item.fact.name}: ${item.fact.value}`
      : item.fact.value;
    rows.push(row([category, value], item.status, [item.evidenceId]));
  }

  const presentCategories = new Set(rows.map((item) => item.cells[0]));
  for (const category of ["Build tool", "Build command(s)", "Test framework", "Test command(s)"]) {
    if (!presentCategories.has(category)) {
      rows.push(placeholderRow([category, "Not Specified"], emptyFieldStatus(catalog, section)));
    }
  }
  return rows;
}

function renderLimitations(catalog: EvidenceCatalogResult): TableRow[] {
  const rows: TableRow[] = [];
  for (const item of catalog.evidence.filter((entry) => entry.profileField === "Limitations / Missing Information" || entry.profileField === "Unmapped")) {
    rows.push(row(
      [item.fact.name, item.fact.value],
      item.status,
      [item.evidenceId],
    ));
  }

  for (const coverage of catalog.coverage) {
    if (coverage.sectionId === "15" || coverage.sectionId === "16") {
      continue;
    }
    if (coverage.status === "not_specified") {
      rows.push(row(
        [coverage.profileField, "No eligible repository evidence was found."],
        "Not Specified",
        coverage.evidenceIds,
      ));
    } else if (coverage.status === "unable_to_verify") {
      rows.push(row(
        [coverage.profileField, issueExplanation(coverage)],
        "Unable to Verify",
        coverage.evidenceIds,
      ));
    } else if (coverage.status === "supported_by_conflicting_evidence") {
      rows.push(row(
        [coverage.profileField, "Credible repository sources disagree; review the cited evidence."],
        "Conflict",
        coverage.conflictingEvidenceIds,
      ));
    } else if (coverage.issues.length > 0) {
      rows.push(row(
        [coverage.profileField, issueExplanation(coverage)],
        "Unable to Verify",
        [],
      ));
    }
  }
  if (rows.length === 0) {
    return [placeholderRow(["Not Specified", "Not Specified"], emptyFieldStatus(catalog, sectionIdForLimitations()))];
  }
  return rows;
}

function renderEvidenceLedger(catalog: EvidenceCatalogResult): string {
  const headers = [
    "Evidence ID", "Profile field", "Source type", "Sanitized source locator",
    "Extracted fact (sanitized)", "Status", "Verification basis", "Confidence",
  ];
  const rows: TableRow[] = sortEvidence(catalog.evidence).map((item) => row([
    item.evidenceId,
    item.profileField,
    item.sourceType,
    item.sourceLocator,
    `${item.fact.name}: ${item.fact.value}`,
    item.status,
    item.verificationBasis,
    item.confidence,
  ], item.status, [item.evidenceId]));
  if (rows.length === 0) {
    rows.push(placeholderRow(["Not Specified", "Not Specified", "Not Specified", "Not Specified", "No eligible evidence found", "Not Specified", "No eligible evidence", "—"], "Not Specified"));
  }
  return renderTable(headers, rows);
}

function renderFactRows(
  catalog: EvidenceCatalogResult,
  section: ProfileSectionId,
  cells: (item: EvidenceItem) => string[],
): TableRow[] {
  const items = evidenceForSection(catalog, section);
  if (items.length === 0) {
    return [placeholderRow(["Not Specified", "Not Specified"], emptyFieldStatus(catalog, section))];
  }
  return items.map((item) => row(cells(item), item.status, [item.evidenceId]));
}

function evidenceForSection(catalog: EvidenceCatalogResult, sectionId: ProfileSectionId): EvidenceItem[] {
  return sortEvidence(catalog.evidence.filter((item) => item.sectionId === sectionId));
}

function emptyFieldStatus(catalog: EvidenceCatalogResult, section: ProfileSectionId): string {
  const coverage = catalog.coverage.find((entry) => entry.sectionId === section);
  if (coverage === undefined) {
    return "Unable to Verify";
  }
  if (coverage.conflictingEvidenceIds.length > 0) {
    return "Conflict";
  }
  if (coverage.unverifiableEvidenceIds.length > 0 || coverage.issues.length > 0 || coverage.status === "unable_to_verify") {
    return "Unable to Verify";
  }
  return "Not Specified";
}

function combinedStatus(items: readonly EvidenceItem[]): string {
  if (items.some((item) => item.status === "Conflict")) {
    return "Conflict";
  }
  if (items.some((item) => item.status === "Unable to Verify")) {
    return "Unable to Verify";
  }
  if (items.some((item) => item.status === "Not Specified")) {
    return "Not Specified";
  }
  return items.length === 0 ? "Not Specified" : "Verified";
}

function placeholderRow(cells: string[], status: string): TableRow {
  return row(cells, status, []);
}

function row(cells: string[], status: string, evidenceIds: string[]): TableRow {
  return { cells, status, evidenceIds: [...new Set(evidenceIds)].sort(compareText) };
}

function renderStandardTable(headers: string[], rows: TableRow[]): string {
  return renderTable(headers, rows.map((item) => ({
    cells: [...item.cells, item.status, formatEvidenceIds(item.evidenceIds)],
    status: item.status,
    evidenceIds: item.evidenceIds,
  })));
}

function renderTable(headers: string[], rows: TableRow[]): string {
  if (rows.some((item) => item.cells.length !== headers.length)) {
    throw new ProfileComposerError("INVALID_TABLE_STRUCTURE");
  }
  const header = `| ${headers.map(escapeCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((item) => `| ${item.cells.map(escapeCell).join(" | ")} |`);
  return `${[header, divider, ...body].join("\n")}\n`;
}

function formatEvidenceIds(evidenceIds: readonly string[]): string {
  return [...new Set(evidenceIds)].sort(compareText).join(", ") || "—";
}

function displayName(item: EvidenceItem): string {
  if (item.profileField === "Repository / Branch") {
    return item.fact.name;
  }
  return item.fact.name;
}

function issueExplanation(coverage: CoverageEntry): string {
  if (coverage.issues.length === 0) {
    return "Relevant repository evidence was unavailable or could not be verified.";
  }
  const explanations = [...new Set(coverage.issues.map((issue) => {
    switch (issue.code) {
      case "EXCLUDED_SOURCE": return "A relevant source was excluded by the approved file policy.";
      case "SENSITIVE_SOURCE_EXCLUDED": return "A relevant source was excluded for sensitive content.";
      case "UNREADABLE_SOURCE": return "A relevant source could not be read safely.";
      case "SOURCE_LIMIT_EXCEEDED": return "Relevant source coverage was limited by the approved size or file-count limits.";
      case "ANALYZER_INPUT_INVALID": return "A relevant source could not be parsed reliably.";
      case "ANALYZER_FAILED": return "A relevant analyzer did not complete successfully.";
      case "UNMAPPED_OBSERVATION": return "Some observations could not be mapped safely to a profile field.";
      case "SCAN_COVERAGE_INCOMPLETE": return "Secret-scan coverage was incomplete.";
    }
  }))];
  return explanations.join(" ");
}

function assertSafeCatalogValue(value: string): string {
  if (containsSensitiveValue(value)) {
    throw new ProfileComposerError("UNSAFE_EVIDENCE");
  }
  return value;
}

function escapeCell(value: string): string {
  const safe = assertSafeCatalogValue(value).normalize("NFC").replace(/\s+/g, " ").trim();
  return safe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/([`*_{}\[\]!])/g, "\\$1");
}

function sortEvidence(evidence: readonly EvidenceItem[]): EvidenceItem[] {
  return [...evidence].sort((left, right) =>
    compareText(left.fieldKey, right.fieldKey) ||
    compareText(left.fact.name, right.fact.name) ||
    compareText(left.fact.value, right.fact.value) ||
    compareText(left.sourceLocator, right.sourceLocator) ||
    compareText(left.evidenceId, right.evidenceId),
  );
}

function isCoverageStatus(value: unknown): value is CoverageStatus {
  return value === "supported_by_verified_evidence" || value === "supported_by_conflicting_evidence" ||
    value === "not_specified" || value === "unable_to_verify";
}

function sectionIdForLimitations(): ProfileSectionId {
  return "15";
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}