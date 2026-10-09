import { TECHNICAL_PROFILE_PATH } from "../collection.js";
import type { RepositoryFilterResult } from "../filter.js";
import type {
  AnalyzerId,
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerOutput,
  TechnologyAnalysisResult,
  TechnologyAnalyzer,
  TechnicalObservation,
} from "./types.js";

export type AnalyzerInputErrorCode = "FILTERED_INPUT_BLOCKED" | "SCAN_COVERAGE_INCOMPLETE";

export class AnalyzerInputError extends Error {
  readonly code: AnalyzerInputErrorCode;

  constructor(code: AnalyzerInputErrorCode) {
    super(code === "FILTERED_INPUT_BLOCKED"
      ? "Technology analysis requires a safe filtered repository snapshot."
      : "Technology analysis requires complete secret-scan coverage.");
    this.name = "AnalyzerInputError";
    this.code = code;
  }
}

export function runTechnologyAnalyzers(
  filtered: RepositoryFilterResult,
  analyzers: readonly TechnologyAnalyzer[],
): TechnologyAnalysisResult {
  const input = createAnalyzerInput(filtered);
  const observations: TechnicalObservation[] = [];
  const issues: AnalyzerIssue[] = [];

  for (const analyzer of [...analyzers].sort((left, right) => compareText(left.id, right.id))) {
    let output: AnalyzerOutput;
    try {
      output = analyzer.analyze(input);
    } catch {
      issues.push({ analyzer: analyzer.id, code: "ANALYZER_FAILED", path: "" });
      continue;
    }
    observations.push(...output.observations);
    issues.push(...output.issues);
  }

  return {
    repositoryId: input.repositoryId,
    defaultBranch: input.defaultBranch,
    snapshotCommitSha: input.snapshotCommitSha,
    observations: uniqueObservations(observations),
    issues: uniqueIssues(issues),
  };
}

export function createAnalyzerInput(filtered: RepositoryFilterResult): AnalyzerInput {
  if (filtered.status === "blocked" || filtered.existingProfile.status === "blocking_sensitive_finding" ||
    filtered.existingProfile.status === "blocked_unavailable") {
    throw new AnalyzerInputError("FILTERED_INPUT_BLOCKED");
  }
  if (filtered.scan.status !== "complete" || !filtered.scan.coverageComplete) {
    throw new AnalyzerInputError("SCAN_COVERAGE_INCOMPLETE");
  }
  return {
    repositoryId: filtered.repositoryId,
    defaultBranch: filtered.defaultBranch,
    snapshotCommitSha: filtered.snapshotCommitSha,
    files: filtered.analysisFiles.filter((file) => file.path !== TECHNICAL_PROFILE_PATH),
  };
}

function uniqueObservations(observations: readonly TechnicalObservation[]): TechnicalObservation[] {
  const unique = new Map<string, TechnicalObservation>();
  for (const observation of observations) {
    const attributes = observation.attributes === undefined
      ? undefined
      : Object.fromEntries(Object.entries(observation.attributes).sort(([left], [right]) => compareText(left, right)));
    const normalized: TechnicalObservation = {
      ...observation,
      ...(attributes === undefined ? {} : { attributes }),
    };
    unique.set(JSON.stringify(normalized), normalized);
  }
  return [...unique.values()].sort(compareObservations);
}

function uniqueIssues(issues: readonly AnalyzerIssue[]): AnalyzerIssue[] {
  const unique = new Map<string, AnalyzerIssue>();
  for (const issue of issues) {
    unique.set(`${issue.analyzer}\0${issue.path}\0${issue.code}`, issue);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.analyzer, right.analyzer) || compareText(left.path, right.path) || compareText(left.code, right.code),
  );
}

function compareObservations(left: TechnicalObservation, right: TechnicalObservation): number {
  return compareText(left.source.path, right.source.path) ||
    compareText(left.source.locator, right.source.locator) ||
    compareText(left.analyzer, right.analyzer) ||
    compareText(left.category, right.category) ||
    compareText(left.name, right.name) ||
    compareText(left.value, right.value);
}

function compareText(left: AnalyzerId | string, right: AnalyzerId | string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}