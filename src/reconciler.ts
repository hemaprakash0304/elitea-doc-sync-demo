import { createHash } from "node:crypto";
import {
  MAX_COLLECTION_FILE_BYTES,
  TECHNICAL_PROFILE_PATH,
  type ExistingProfileInput,
} from "./collection.js";
import { containsSensitiveValue } from "./analyzers/observation.js";
import type { EvidenceCatalogResult, ProfileSectionId } from "./evidence/types.js";
import type { ProfileCompositionResult } from "./composer.js";
import type { RepositoryFilterResult } from "./filter.js";

export type ReconciliationStatus = "FIRST_GENERATION" | "CHANGED" | "NO_CHANGES" | "BLOCKED" | "FAILED";
export type ReconciliationOperation = "addition" | "modification" | "removal";

export type ReconciliationIssueCode =
  | "FILTERED_INPUT_UNSAFE"
  | "PROFILE_SENSITIVE_CONTENT"
  | "PROFILE_SIZE_LIMIT"
  | "PROFILE_INVALID_ENCODING"
  | "PROFILE_SNAPSHOT_MISMATCH"
  | "GLOBAL_MARKER_MISSING"
  | "GLOBAL_MARKER_INVALID"
  | "SECTION_MISSING"
  | "SECTION_DUPLICATE"
  | "SECTION_ORDER_INVALID"
  | "MARKER_MALFORMED"
  | "MARKER_SCHEMA_UNSUPPORTED"
  | "MARKER_STRUCTURE_INVALID"
  | "DIGEST_MISMATCH"
  | "TABLE_SCHEMA_INVALID"
  | "REQUIRED_FIELD_MISSING"
  | "DUPLICATE_FIELD"
  | "OWNERSHIP_AMBIGUOUS"
  | "SNAPSHOT_MISMATCH"
  | "CANDIDATE_INVALID"
  | "RECONCILIATION_FAILED";

export interface ReconciliationIssue {
  code: ReconciliationIssueCode;
  sectionId?: ProfileSectionId;
}

export interface ReconciliationChange {
  operation: ReconciliationOperation;
  sectionId: ProfileSectionId;
  section: string;
  rowKey: string;
  before?: readonly string[];
  after?: readonly string[];
  evidenceIds: string[];
}

export interface ReconciliationConflict {
  sectionId: ProfileSectionId | null;
  profileField: string;
  evidenceIds: string[];
}

export interface ProfileReconciliationResult {
  status: ReconciliationStatus;
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  candidate?: string;
  candidateSha256?: string;
  schemaVersion: number;
  additions: ReconciliationChange[];
  modifications: ReconciliationChange[];
  removals: ReconciliationChange[];
  conflicts: ReconciliationConflict[];
  preservedManualContent: boolean;
  existingProfilePreserved: boolean;
  issues: ReconciliationIssue[];
}

interface LineSpan {
  text: string;
  start: number;
  end: number;
  fullEnd: number;
}

interface ParsedRow {
  cells: string[];
  raw: string;
}

interface ManualNotes {
  raw: string;
  placement: "before" | "after";
}

interface ParsedSection {
  id: ProfileSectionId;
  heading: string;
  start: LineSpan;
  end: LineSpan;
  startMarker: LineSpan;
  endMarker: LineSpan;
  body: string;
  rows: ParsedRow[];
  manualNotes?: ManualNotes;
}

interface ParsedProfile {
  sections: ParsedSection[];
}

interface ParseResult {
  profile?: ParsedProfile;
  issue?: ReconciliationIssue;
}

const GENERATED_MARKER = "<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->";
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
const SECTION_ORDER: ProfileSectionId[] = [
  "01", "02", "03", "04", "05", "06", "07", "08",
  "09", "10", "11", "12", "13", "14", "15", "16",
];
const SECTION_HEADERS: Readonly<Record<ProfileSectionId, readonly string[]>> = {
  "01": ["Field", "Value", "Status", "Evidence IDs"],
  "02": ["Field", "Value", "Status", "Evidence IDs"],
  "03": ["Field", "Value", "Status", "Evidence IDs"],
  "04": ["Framework/Library", "Declared or observed version", "Status", "Evidence IDs"],
  "05": ["Dependency", "Scope", "Declared version/specifier", "Lockfile-resolved version", "Status", "Evidence IDs"],
  "06": ["Technology", "Repository evidence/role", "Status", "Evidence IDs"],
  "07": ["API/Integration", "Observed repository reference", "Status", "Evidence IDs"],
  "08": ["Variable name", "Evidence-backed purpose, if specified", "Status", "Evidence IDs"],
  "09": ["Category", "Tool/framework/command", "Status", "Evidence IDs"],
  "10": ["Workflow/job/trigger/step", "Repository declaration", "Status", "Evidence IDs"],
  "11": ["Declared component/resource", "Repository declaration", "Status", "Evidence IDs"],
  "12": ["Observed security configuration/control", "Repository declaration", "Status", "Evidence IDs"],
  "13": ["Library/configuration/reference", "Repository declaration", "Status", "Evidence IDs"],
  "14": ["Field", "Value", "Status", "Evidence IDs"],
  "15": ["Limitation or missing field", "Safe explanation", "Status", "Evidence IDs"],
  "16": ["Evidence ID", "Profile field", "Source type", "Sanitized source locator", "Extracted fact (sanitized)", "Status", "Verification basis", "Confidence"],
};
const ALLOWED_STATUSES = new Set(["Verified", "Not Specified", "Unable to Verify", "Conflict"]);
const EVIDENCE_ID_PATTERN = /^E[0-9A-F]{64}$/;
const START_MARKER = /^<!-- docs-sync:generated:start section=(\d{2}) schema=(\d+) sha256=([a-f0-9]{64}) -->$/;
const END_MARKER = /^<!-- docs-sync:generated:end section=(\d{2}) -->$/;
const MARKER_TEXT = /docs-sync:generated:(?:start|end)/;
const HTML_ESCAPE_VALUES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&#39;": "'",
  "&quot;": "\"",
};

export function reconcileTechnicalProfile(
  filtered: RepositoryFilterResult,
  existingProfile: ExistingProfileInput,
  catalog: EvidenceCatalogResult,
  composition: ProfileCompositionResult,
): ProfileReconciliationResult {
  const base = {
    repositoryId: filtered.repositoryId,
    defaultBranch: filtered.defaultBranch,
    snapshotCommitSha: filtered.snapshotCommitSha,
    schemaVersion: composition.schemaVersion,
    additions: [] as ReconciliationChange[],
    modifications: [] as ReconciliationChange[],
    removals: [] as ReconciliationChange[],
    conflicts: collectConflicts(catalog),
    preservedManualContent: false,
    existingProfilePreserved: existingProfile.profilePresent,
  };

  const filterIssue = validateFilteredState(filtered, existingProfile);
  if (filterIssue !== undefined) {
    return { ...base, status: "BLOCKED", issues: [filterIssue] };
  }
  if (!snapshotsMatch(filtered, catalog, composition) || !verifyCandidateDigest(composition)) {
    return { ...base, status: "FAILED", issues: [{ code: "SNAPSHOT_MISMATCH" }] };
  }
  if (containsSensitiveValue(composition.candidate)) {
    return { ...base, status: "BLOCKED", issues: [{ code: "CANDIDATE_INVALID" }] };
  }

  const candidateProfile = parseProfile(composition.candidate);
  if (candidateProfile.profile === undefined) {
    return { ...base, status: "FAILED", issues: [candidateProfile.issue ?? { code: "CANDIDATE_INVALID" }] };
  }

  if (!existingProfile.profilePresent) {
    const changes = compareProfiles(undefined, candidateProfile.profile);
    return {
      ...base,
      status: "FIRST_GENERATION",
      candidate: composition.candidate,
      candidateSha256: sha256(composition.candidate),
      additions: changes.additions,
      modifications: changes.modifications,
      removals: changes.removals,
      issues: [],
    };
  }

  const file = existingProfile.file;
  if (
    filtered.existingProfile.status !== "safe_to_parse" ||
    file.path !== TECHNICAL_PROFILE_PATH ||
    file.kind !== "regular" || file.contentStatus !== "text" || file.content === undefined ||
    file.size > MAX_COLLECTION_FILE_BYTES || Buffer.byteLength(file.content, "utf8") !== file.size ||
    file.sourceCommitSha.toLowerCase() !== filtered.snapshotCommitSha.toLowerCase()
  ) {
    return { ...base, status: "BLOCKED", issues: [{ code: file.size > MAX_COLLECTION_FILE_BYTES ? "PROFILE_SIZE_LIMIT" : "PROFILE_SNAPSHOT_MISMATCH" }] };
  }
  if (containsSensitiveValue(file.content)) {
    return { ...base, status: "BLOCKED", issues: [{ code: "PROFILE_SENSITIVE_CONTENT" }] };
  }

  const parsedExisting = parseProfile(file.content);
  if (parsedExisting.profile === undefined) {
    return { ...base, status: "BLOCKED", issues: [parsedExisting.issue ?? { code: "OWNERSHIP_AMBIGUOUS" }] };
  }

  const manualNotes = parsedExisting.profile.sections.flatMap((section) =>
    section.manualNotes === undefined ? [] : [{ sectionId: section.id, notes: section.manualNotes }],
  );
  const generatedBlocksUnchanged = parsedExisting.profile.sections.every((existingSection) => {
    const candidateSection = candidateProfile.profile?.sections.find((section) => section.id === existingSection.id);
    return candidateSection !== undefined && existingSection.body === candidateSection.body;
  });
  if (generatedBlocksUnchanged) {
    return {
      ...base,
      status: "NO_CHANGES",
      candidate: file.content,
      candidateSha256: sha256(file.content),
      preservedManualContent: manualNotes.length > 0,
      issues: [],
    };
  }

  const candidate = insertManualNotes(composition.candidate, candidateProfile.profile, manualNotes);
  if (containsSensitiveValue(candidate)) {
    return { ...base, status: "BLOCKED", issues: [{ code: "CANDIDATE_INVALID" }] };
  }
  const parsedCandidate = parseProfile(candidate);
  if (parsedCandidate.profile === undefined) {
    return { ...base, status: "BLOCKED", issues: [parsedCandidate.issue ?? { code: "OWNERSHIP_AMBIGUOUS" }] };
  }
  const finalChanges = compareProfiles(parsedExisting.profile, parsedCandidate.profile);
  const isNoOp = candidate === file.content;
  return {
    ...base,
    status: isNoOp ? "NO_CHANGES" : "CHANGED",
    candidate,
    candidateSha256: sha256(candidate),
    additions: finalChanges.additions,
    modifications: finalChanges.modifications,
    removals: finalChanges.removals,
    preservedManualContent: manualNotes.length > 0,
    issues: [],
  };
}

function validateFilteredState(
  filtered: RepositoryFilterResult,
  existingProfile: ExistingProfileInput,
): ReconciliationIssue | undefined {
  if (
    filtered.status === "blocked" || filtered.scan.status !== "complete" || !filtered.scan.coverageComplete ||
    filtered.existingProfile.status === "blocking_sensitive_finding" ||
    filtered.existingProfile.status === "blocked_unavailable"
  ) {
    return { code: "FILTERED_INPUT_UNSAFE" };
  }
  if (
    !/^[0-9a-f]{40}$/i.test(filtered.snapshotCommitSha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(filtered.repositoryId) || containsSensitiveValue(filtered.defaultBranch)
  ) {
    return { code: "SNAPSHOT_MISMATCH" };
  }
  if (
    existingProfile.profilePresent &&
    (filtered.existingProfile.status !== "safe_to_parse" || existingProfile.file.path !== TECHNICAL_PROFILE_PATH)
  ) {
    return { code: "FILTERED_INPUT_UNSAFE" };
  }
  if (!existingProfile.profilePresent && filtered.existingProfile.status !== "absent") {
    return { code: "FILTERED_INPUT_UNSAFE" };
  }
  return undefined;
}

function snapshotsMatch(
  filtered: RepositoryFilterResult,
  catalog: EvidenceCatalogResult,
  composition: ProfileCompositionResult,
): boolean {
  return catalog.repositoryId === filtered.repositoryId &&
    composition.repositoryId === filtered.repositoryId &&
    catalog.defaultBranch === filtered.defaultBranch &&
    composition.defaultBranch === filtered.defaultBranch &&
    catalog.snapshotCommitSha.toLowerCase() === filtered.snapshotCommitSha.toLowerCase() &&
    composition.snapshotCommitSha.toLowerCase() === filtered.snapshotCommitSha.toLowerCase();
}

function verifyCandidateDigest(composition: ProfileCompositionResult): boolean {
  return composition.schemaVersion === 1 &&
    sha256(composition.candidate) === composition.candidateSha256.toLowerCase();
}

function parseProfile(content: string): ParseResult {
  const lines = splitLines(content);
  if (containsSensitiveValue(content)) {
    return { issue: { code: "PROFILE_SENSITIVE_CONTENT" } };
  }
  if (lines.length === 0 || lines[0]?.text !== "# Technical Profile") {
    return { issue: { code: "GLOBAL_MARKER_MISSING" } };
  }
  const globalMarkerLines = lines.filter((line) => line.text === GENERATED_MARKER);
  if (globalMarkerLines.length === 0) {
    return { issue: { code: "GLOBAL_MARKER_MISSING" } };
  }
  if (globalMarkerLines.length !== 1) {
    return { issue: { code: "GLOBAL_MARKER_INVALID" } };
  }

  const headings = lines.filter((line) => /^##\s+/.test(line.text));
  if (headings.length < SECTION_ORDER.length) {
    return { issue: { code: "SECTION_MISSING" } };
  }
  if (headings.length > SECTION_ORDER.length) {
    return { issue: { code: "SECTION_DUPLICATE" } };
  }

  const sectionSpans: Array<{ id: ProfileSectionId; heading: LineSpan; endIndex: number }> = [];
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    const expectedId = SECTION_ORDER[index];
    if (heading === undefined || expectedId === undefined) {
      return { issue: { code: "SECTION_ORDER_INVALID" } };
    }
    const expectedHeading = `## ${Number(expectedId)}. ${SECTION_TITLES[expectedId]}`;
    if (heading.text !== expectedHeading) {
      const duplicate = headings.some((other, otherIndex) => otherIndex !== index && other.text === heading.text);
      return { issue: { code: duplicate ? "SECTION_DUPLICATE" : "SECTION_ORDER_INVALID", sectionId: expectedId } };
    }
    const lineIndex = lines.indexOf(heading);
    const endIndex = index + 1 < headings.length ? lines.indexOf(headings[index + 1] as LineSpan) : lines.length;
    sectionSpans.push({ id: expectedId, heading, endIndex });
    if (lineIndex < 0 || endIndex <= lineIndex) {
      return { issue: { code: "SECTION_ORDER_INVALID", sectionId: expectedId } };
    }
  }

  const starts = lines.filter((line) => START_MARKER.test(line.text));
  const ends = lines.filter((line) => END_MARKER.test(line.text));
  const markerLikeLines = lines.filter((line) => MARKER_TEXT.test(line.text));
  if (markerLikeLines.length !== starts.length + ends.length || starts.length !== SECTION_ORDER.length || ends.length !== SECTION_ORDER.length) {
    return { issue: { code: "MARKER_MALFORMED" } };
  }

  const headerLines = lines.filter((line) => line.start < (sectionSpans[0]?.heading.start ?? content.length));
  if (headerLines.some((line) => line.text.length > 0 && line.text !== "# Technical Profile" && line.text !== GENERATED_MARKER)) {
    return { issue: { code: "OWNERSHIP_AMBIGUOUS" } };
  }

  const sections: ParsedSection[] = [];
  for (let sectionIndex = 0; sectionIndex < sectionSpans.length; sectionIndex += 1) {
    const span = sectionSpans[sectionIndex];
    if (span === undefined) {
      return { issue: { code: "SECTION_ORDER_INVALID" } };
    }
    const contentStart = lines.indexOf(span.heading) + 1;
    const sectionLines = lines.slice(contentStart, span.endIndex);
    const sectionStarts = sectionLines.filter((line) => START_MARKER.test(line.text));
    const sectionEnds = sectionLines.filter((line) => END_MARKER.test(line.text));
    if (sectionStarts.length !== 1 || sectionEnds.length !== 1) {
      return { issue: { code: "MARKER_STRUCTURE_INVALID", sectionId: span.id } };
    }
    const startMarker = sectionStarts[0];
    const endMarker = sectionEnds[0];
    if (startMarker === undefined || endMarker === undefined || lines.indexOf(startMarker) >= lines.indexOf(endMarker)) {
      return { issue: { code: "MARKER_STRUCTURE_INVALID", sectionId: span.id } };
    }
    const startMatch = START_MARKER.exec(startMarker.text);
    const endMatch = END_MARKER.exec(endMarker.text);
    if (startMatch?.[1] !== span.id || endMatch?.[1] !== span.id) {
      return { issue: { code: "MARKER_STRUCTURE_INVALID", sectionId: span.id } };
    }
    if (Number(startMatch[2]) !== 1) {
      return { issue: { code: "MARKER_SCHEMA_UNSUPPORTED", sectionId: span.id } };
    }
    const body = content.slice(startMarker.fullEnd, endMarker.start);
    if (sha256(body) !== startMatch[3]) {
      return { issue: { code: "DIGEST_MISMATCH", sectionId: span.id } };
    }
    const rows = parseTable(body, span.id);
    if (rows === undefined) {
      return { issue: { code: "TABLE_SCHEMA_INVALID", sectionId: span.id } };
    }
    const requiredIssue = validateRequiredFields(span.id, rows);
    if (requiredIssue !== undefined) {
      return { issue: requiredIssue };
    }
    const notesResult = parseManualNotes(content, lines, span, startMarker, endMarker, sectionLines);
    if (notesResult.issue !== undefined) {
      return { issue: notesResult.issue };
    }
    sections.push({
      id: span.id,
      heading: span.heading.text,
      start: span.heading,
      end: lines[span.endIndex] ?? { text: "", start: content.length, end: content.length, fullEnd: content.length },
      startMarker,
      endMarker,
      body,
      rows,
      ...(notesResult.notes === undefined ? {} : { manualNotes: notesResult.notes }),
    });
  }

  return { profile: { sections } };
}

function parseTable(body: string, sectionId: ProfileSectionId): ParsedRow[] | undefined {
  const normalized = body.replace(/\r\n/g, "\n");
  if (!normalized.endsWith("\n")) {
    return undefined;
  }
  const lines = normalized.slice(0, -1).split("\n");
  if (lines.length < 3 || lines.some((line) => !line.startsWith("|") || !line.endsWith("|"))) {
    return undefined;
  }
  const rows = lines.map((line) => ({ cells: parseMarkdownRow(line), raw: line }));
  const expectedHeaders = SECTION_HEADERS[sectionId];
  const header = rows[0]?.cells;
  const separator = rows[1]?.cells;
  if (
    expectedHeaders === undefined || header === undefined || separator === undefined ||
    !arrayEquals(header, expectedHeaders) || separator.length !== expectedHeaders.length ||
    separator.some((cell) => !/^:?-{3,}:?$/.test(cell)) ||
    rows.some((row) => row.cells.length !== expectedHeaders.length)
  ) {
    return undefined;
  }

  const dataRows = rows.slice(2);
  const statusIndex = sectionId === "16" ? 5 : expectedHeaders.length - 2;
  const seen = new Set<string>();
  for (const row of dataRows) {
    const status = row.cells[statusIndex];
    if (status === undefined || !ALLOWED_STATUSES.has(status)) {
      return undefined;
    }
    const evidenceCell = sectionId === "16" ? row.cells[0] : row.cells.at(-1);
    if (evidenceCell === undefined || (evidenceCell !== "—" && evidenceCell.split(", ").some((id) => !EVIDENCE_ID_PATTERN.test(id)))) {
      return undefined;
    }
    if (seen.has(stableJson(row.cells))) {
      return undefined;
    }
    seen.add(stableJson(row.cells));
  }
  return dataRows;
}

function parseManualNotes(
  content: string,
  lines: readonly LineSpan[],
  span: { id: ProfileSectionId; heading: LineSpan; endIndex: number },
  startMarker: LineSpan,
  endMarker: LineSpan,
  sectionLines: readonly LineSpan[],
): { notes?: ManualNotes; issue?: ReconciliationIssue } {
  const sectionStartLine = lines.indexOf(span.heading);
  const sectionStart = sectionStartLine + 1;
  const sectionEnd = span.endIndex;
  const startIndex = lines.indexOf(startMarker);
  const endIndex = lines.indexOf(endMarker);
  let index = sectionStart;
  let notes: ManualNotes | undefined;

  while (index < sectionEnd) {
    if (index >= startIndex && index <= endIndex) {
      index = endIndex + 1;
      continue;
    }
    const line = lines[index];
    if (line === undefined || line.text.trim().length === 0) {
      index += 1;
      continue;
    }
    if (line.text !== "### Human-maintained notes" || notes !== undefined) {
      return { issue: { code: "OWNERSHIP_AMBIGUOUS", sectionId: span.id } };
    }
    const noteStart = index;
    index += 1;
    while (index < sectionEnd && index !== startIndex && index !== endIndex) {
      if (lines[index]?.text.startsWith("### ")) {
        return { issue: { code: "OWNERSHIP_AMBIGUOUS", sectionId: span.id } };
      }
      index += 1;
    }
    const nextSpan = index < sectionEnd ? lines[index] : lines[sectionEnd];
    const noteEnd = nextSpan?.start ?? content.length;
    const raw = content.slice(lines[noteStart]?.start ?? line.start, noteEnd);
    notes = {
      raw,
      placement: noteStart < startIndex ? "before" : "after",
    };
  }

  void sectionLines;
  return notes === undefined ? {} : { notes };
}

function validateRequiredFields(sectionId: ProfileSectionId, rows: readonly ParsedRow[]): ReconciliationIssue | undefined {
  const firstCells = rows.map((row) => row.cells[0] ?? "");
  const uniqueRequired: Partial<Record<ProfileSectionId, readonly string[]>> = {
    "01": ["Application Name"],
    "02": ["Description"],
    "03": ["Primary language", "Runtime(s)"],
    "09": ["Build tool", "Build command(s)", "Test framework", "Test command(s)"],
    "14": ["Repository", "Default branch", "Analyzed commit/ref"],
  };
  const required = uniqueRequired[sectionId];
  if (required !== undefined && required.some((field) => !firstCells.includes(field))) {
    return { code: "REQUIRED_FIELD_MISSING", sectionId };
  }
  if (["04", "05", "06", "07", "08", "10", "11", "12", "13", "15", "16"].includes(sectionId) && rows.length === 0) {
    return { code: "REQUIRED_FIELD_MISSING", sectionId };
  }

  for (const field of required ?? []) {
    if (firstCells.filter((value) => value === field).length !== 1) {
      return { code: "DUPLICATE_FIELD", sectionId };
    }
  }
  if (sectionId === "14" && firstCells.filter((value) => value === "Repository").length !== 1) {
    return { code: "DUPLICATE_FIELD", sectionId };
  }
  if (sectionId === "09") {
    for (const field of ["Build tool", "Test framework"]) {
      if (firstCells.filter((value) => value === field).length !== 1) {
        return { code: "DUPLICATE_FIELD", sectionId };
      }
    }
  }
  return undefined;
}

function compareProfiles(existing: ParsedProfile | undefined, candidate: ParsedProfile): {
  additions: ReconciliationChange[];
  modifications: ReconciliationChange[];
  removals: ReconciliationChange[];
} {
  const additions: ReconciliationChange[] = [];
  const modifications: ReconciliationChange[] = [];
  const removals: ReconciliationChange[] = [];

  for (const candidateSection of candidate.sections) {
    const existingSection = existing?.sections.find((section) => section.id === candidateSection.id);
    const oldRows = [...(existingSection?.rows ?? [])];
    const newRows = [...candidateSection.rows];
    removeExactMatches(oldRows, newRows);

    const keys = [...new Set([...oldRows, ...newRows].map((row) => rowIdentity(candidateSection.id, row.cells)))].sort(compareText);
    for (const key of keys) {
      const oldGroup = oldRows.filter((row) => rowIdentity(candidateSection.id, row.cells) === key).sort(compareRows);
      const newGroup = newRows.filter((row) => rowIdentity(candidateSection.id, row.cells) === key).sort(compareRows);
      const paired = Math.min(oldGroup.length, newGroup.length);
      for (let index = 0; index < paired; index += 1) {
        const before = oldGroup[index];
        const after = newGroup[index];
        if (before === undefined || after === undefined) {
          continue;
        }
        modifications.push(change("modification", candidateSection, key, before, after));
      }
      for (const before of oldGroup.slice(paired)) {
        removals.push(change("removal", candidateSection, key, before, undefined));
      }
      for (const after of newGroup.slice(paired)) {
        additions.push(change("addition", candidateSection, key, undefined, after));
      }
    }
  }
  return {
    additions: sortChanges(additions),
    modifications: sortChanges(modifications),
    removals: sortChanges(removals),
  };
}

function removeExactMatches(existing: ParsedRow[], candidate: ParsedRow[]): void {
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    const oldRow = existing[index];
    if (oldRow === undefined) {
      continue;
    }
    const match = candidate.findIndex((newRow) => stableJson(newRow.cells) === stableJson(oldRow.cells));
    if (match >= 0) {
      existing.splice(index, 1);
      candidate.splice(match, 1);
    }
  }
}

function insertManualNotes(
  candidate: string,
  parsedCandidate: ParsedProfile,
  manualNotes: readonly { sectionId: ProfileSectionId; notes: ManualNotes }[],
): string {
  let result = candidate;
  const insertions: Array<{ offset: number; value: string }> = [];
  for (const { sectionId, notes } of manualNotes) {
    const section = parsedCandidate.sections.find((entry) => entry.id === sectionId);
    if (section === undefined) {
      continue;
    }
    const offset = notes.placement === "before" ? section.startMarker.start : section.endMarker.fullEnd;
    insertions.push({ offset, value: notes.raw });
  }
  insertions.sort((left, right) => right.offset - left.offset);
  for (const insertion of insertions) {
    result = `${result.slice(0, insertion.offset)}${insertion.value}${result.slice(insertion.offset)}`;
  }
  return result;
}

function rowIdentity(sectionId: ProfileSectionId, cells: readonly string[]): string {
  const first = cells[0] ?? "";
  if (sectionId === "05") {
    return `${first}\0${cells[1] ?? ""}`;
  }
  if (sectionId === "04") {
    return `${first}\0${cells[1] ?? ""}`;
  }
  if (sectionId === "16") {
    return first;
  }
  return first;
}

function parseMarkdownRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  for (let index = 1; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === undefined) {
      continue;
    }
    if (escaped) {
      cell += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(decodeMarkdownCell(cell));
      cell = "";
    } else {
      cell += character;
    }
  }
  if (escaped) {
    cell += "\\";
  }
  cells.push(decodeMarkdownCell(cell));
  return cells;
}

function decodeMarkdownCell(value: string): string {
  let result = value.trim().replace(/\\([\\`*_{}\[\]!])/g, "$1");
  for (const [encoded, decoded] of Object.entries(HTML_ESCAPE_VALUES)) {
    result = result.replaceAll(encoded, decoded);
  }
  return result;
}

function splitLines(content: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const fullEnd = newline < 0 ? content.length : newline + 1;
    const end = newline < 0 ? content.length : newline;
    const rawLine = content.slice(start, end);
    lines.push({ text: rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, start, end, fullEnd });
    start = fullEnd;
  }
  if (content.length === 0) {
    return [];
  }
  return lines;
}

function change(
  operation: ReconciliationOperation,
  section: ParsedSection,
  rowKey: string,
  before: ParsedRow | undefined,
  after: ParsedRow | undefined,
): ReconciliationChange {
  return {
    operation,
    sectionId: section.id,
    section: SECTION_TITLES[section.id],
    rowKey,
    ...(before === undefined ? {} : { before: before.cells }),
    ...(after === undefined ? {} : { after: after.cells }),
    evidenceIds: [...new Set([...extractEvidenceIds(before?.cells ?? []), ...extractEvidenceIds(after?.cells ?? [])])].sort(compareText),
  };
}

function extractEvidenceIds(cells: readonly string[]): string[] {
  return cells.flatMap((cell) => cell.match(/E[0-9A-F]{64}/g) ?? []).sort(compareText);
}

function collectConflicts(catalog: EvidenceCatalogResult): ReconciliationConflict[] {
  const groups = new Map<string, ReconciliationConflict>();
  for (const item of catalog.evidence) {
    if (item.status !== "Conflict") {
      continue;
    }
    const key = `${item.sectionId ?? "unmapped"}\0${item.profileField}`;
    const group = groups.get(key) ?? {
      sectionId: item.sectionId,
      profileField: item.profileField,
      evidenceIds: [],
    };
    group.evidenceIds.push(item.evidenceId);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((conflict) => ({ ...conflict, evidenceIds: [...new Set(conflict.evidenceIds)].sort(compareText) }))
    .sort((left, right) => compareText(left.sectionId ?? "99", right.sectionId ?? "99") || compareText(left.profileField, right.profileField));
}

function sortChanges(changes: ReconciliationChange[]): ReconciliationChange[] {
  const operationOrder: Record<ReconciliationOperation, number> = { addition: 0, modification: 1, removal: 2 };
  return changes.sort((left, right) =>
    compareText(left.sectionId, right.sectionId) ||
    compareText(left.rowKey, right.rowKey) ||
    operationOrder[left.operation] - operationOrder[right.operation] ||
    compareText(stableJson(left.before ?? []), stableJson(right.before ?? [])) ||
    compareText(stableJson(left.after ?? []), stableJson(right.after ?? [])),
  );
}

function compareRows(left: ParsedRow, right: ParsedRow): number {
  return compareText(stableJson(left.cells), stableJson(right.cells));
}

function arrayEquals(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => compareText(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}