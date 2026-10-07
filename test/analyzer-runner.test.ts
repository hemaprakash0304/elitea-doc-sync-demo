import assert from "node:assert/strict";
import test from "node:test";
import { AnalyzerInputError, runTechnologyAnalyzers } from "../src/analyzers/runner.js";
import type { RepositoryFilterResult } from "../src/filter.js";
import type { TechnologyAnalyzer } from "../src/analyzers/types.js";

const SNAPSHOT_SHA = "d".repeat(40);

function filteredSnapshot(overrides: Partial<RepositoryFilterResult> = {}): RepositoryFilterResult {
  return {
    status: "ready",
    repositoryId: "sample/repo",
    defaultBranch: "release",
    snapshotCommitSha: SNAPSHOT_SHA,
    analysisFiles: [{
      path: "README.md",
      extension: ".md",
      content: "sanitized text",
      sourceCommitSha: SNAPSHOT_SHA,
      blobSha: "e".repeat(40),
    }],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: {
      status: "complete",
      scanner: "test_double",
      expectedFileCount: 1,
      scannedFileCount: 1,
      coverageComplete: true,
    },
    existingProfile: { status: "absent" },
    ...overrides,
  };
}

test("runs common analyzers over only the filtered files and binds results to the snapshot", () => {
  const observedPaths: string[][] = [];
  const makeAnalyzer = (id: "java_maven" | "documentation", value: string): TechnologyAnalyzer => ({
    id,
    analyze(input) {
      observedPaths.push(input.files.map((file) => file.path));
      return {
        observations: [{
          analyzer: id,
          category: "documentation_technology_claim",
          name: value,
          value,
          source: { path: "README.md", locator: "line:1", kind: "documentation" },
          claimType: "documentation_claim",
          status: "Verified",
          verificationBasis: "documentation_claim",
          confidence: "Low",
        }],
        issues: [],
      };
    },
  });

  const input = filteredSnapshot();
  const result = runTechnologyAnalyzers(input, [makeAnalyzer("java_maven", "Java"), makeAnalyzer("documentation", "Docker")]);

  assert.equal(result.snapshotCommitSha, SNAPSHOT_SHA);
  assert.equal(result.defaultBranch, "release");
  assert.deepEqual(observedPaths, [["README.md"], ["README.md"]]);
  assert.deepEqual(result.observations.map((observation) => observation.analyzer), ["documentation", "java_maven"]);
  assert.deepEqual(input.analysisFiles[0]?.content, "sanitized text");
  assert.equal("files" in result, false);
});

test("rejects blocked snapshots and incomplete scan coverage before calling analyzers", () => {
  let calls = 0;
  const analyzer: TechnologyAnalyzer = {
    id: "documentation",
    analyze() {
      calls += 1;
      return { observations: [], issues: [] };
    },
  };

  assert.throws(
    () => runTechnologyAnalyzers(filteredSnapshot({ status: "blocked" }), [analyzer]),
    (error: unknown) => error instanceof AnalyzerInputError && error.code === "FILTERED_INPUT_BLOCKED",
  );
  assert.throws(
    () => runTechnologyAnalyzers(filteredSnapshot({ scan: {
      status: "incomplete",
      scanner: "test_double",
      expectedFileCount: 1,
      scannedFileCount: 0,
      coverageComplete: false,
    } }), [analyzer]),
    (error: unknown) => error instanceof AnalyzerInputError && error.code === "SCAN_COVERAGE_INCOMPLETE",
  );
  assert.equal(calls, 0);
});
