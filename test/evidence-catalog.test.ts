import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceCatalog, EvidenceCatalogError } from "../src/evidence/catalog.js";
import { authorityRank, mapObservation } from "../src/evidence/mapping.js";
import { PROFILE_SECTIONS, type EvidenceCatalogResult } from "../src/evidence/types.js";
import type { AnalyzerIssue, TechnicalObservation, TechnologyAnalysisResult } from "../src/analyzers/types.js";
import type { RepositoryFilterResult } from "../src/filter.js";

const SNAPSHOT_SHA = "a".repeat(40);
const REPOSITORY_ID = "sample/catalog";
const DEFAULT_BRANCH = "release/next";
const REPOSITORY_FULL_NAME = "sample/catalog";

function filtered(overrides: Partial<RepositoryFilterResult> = {}): RepositoryFilterResult {
  return {
    status: "ready",
    repositoryId: REPOSITORY_ID,
    defaultBranch: DEFAULT_BRANCH,
    snapshotCommitSha: SNAPSHOT_SHA,
    analysisFiles: [],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: {
      status: "complete",
      scanner: "test_double",
      expectedFileCount: 0,
      scannedFileCount: 0,
      coverageComplete: true,
    },
    existingProfile: { status: "absent" },
    ...overrides,
  };
}

function observation(
  overrides: Partial<TechnicalObservation> & Pick<TechnicalObservation, "analyzer" | "category" | "name" | "value" | "source">,
): TechnicalObservation {
  return {
    claimType: "declaration",
    status: "Verified",
    verificationBasis: "manifest_declaration",
    confidence: "High",
    ...overrides,
  };
}

function analysis(
  observations: TechnicalObservation[] = [],
  issues: AnalyzerIssue[] = [],
  overrides: Partial<TechnologyAnalysisResult> = {},
): TechnologyAnalysisResult {
  return {
    repositoryId: REPOSITORY_ID,
    defaultBranch: DEFAULT_BRANCH,
    snapshotCommitSha: SNAPSHOT_SHA,
    observations,
    issues,
    ...overrides,
  };
}

function build(
  sourceObservations: TechnicalObservation[] = [],
  filteredInput = filtered(),
  sourceIssues: AnalyzerIssue[] = [],
): EvidenceCatalogResult {
  return buildEvidenceCatalog(filteredInput, analysis(sourceObservations, sourceIssues), {
    repositoryFullName: REPOSITORY_FULL_NAME,
  });
}

function makeObservation(overrides: Partial<TechnicalObservation> & Pick<TechnicalObservation, "analyzer" | "category" | "name" | "value">): TechnicalObservation {
  return observation({
    source: { path: "package.json", locator: "package.json:name", kind: "manifest" },
    ...overrides,
  });
}

test("creates deterministic snapshot-bound Evidence IDs and distinct IDs for distinct facts", () => {
  const fact = makeObservation({ analyzer: "javascript_node", category: "package_name", name: "Package name", value: "catalog-app" });
  const first = build([fact]);
  const second = build([fact]);
  const firstItem = first.evidence.find((item) => item.fact.value === "catalog-app");
  const secondItem = second.evidence.find((item) => item.fact.value === "catalog-app");

  assert.ok(firstItem);
  assert.equal(firstItem.evidenceId, secondItem?.evidenceId);
  assert.match(firstItem.evidenceId, /^E[0-9A-F]{64}$/);
  assert.notEqual(firstItem.evidenceId, build([
    makeObservation({ analyzer: "javascript_node", category: "package_name", name: "Package name", value: "different-app" }),
  ]).evidence.find((item) => item.fact.value === "different-app")?.evidenceId);
  const changedSnapshotSha = "b".repeat(40);
  const changedSnapshot = buildEvidenceCatalog(
    filtered({ snapshotCommitSha: changedSnapshotSha }),
    analysis([fact], [], { snapshotCommitSha: changedSnapshotSha }),
    { repositoryFullName: REPOSITORY_FULL_NAME },
  );
  assert.notEqual(firstItem.evidenceId, changedSnapshot.evidence.find((item) => item.fact.value === "catalog-app")?.evidenceId);
  assert.equal("timestamp" in firstItem, false);
  assert.equal("createdAt" in firstItem, false);
});

test("normalizes paths, locators, whitespace, and object property ordering before ID generation", () => {
  const first = makeObservation({
    analyzer: "javascript_node",
    category: "dependency",
    name: "  zod  ",
    value: " ^3.0.0   ",
    source: { path: "./src//package.json", locator: "line:0007", kind: "manifest" },
    attributes: { z: " last ", a: " first " },
  });
  const second = makeObservation({
    analyzer: "javascript_node",
    category: "dependency",
    name: "zod",
    value: "^3.0.0",
    source: { path: "src/package.json", locator: "line:7", kind: "manifest" },
    attributes: { a: "first", z: "last" },
  });
  const result = build([first, second]);
  const matches = result.evidence.filter((item) => item.fact.name === "zod");

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.sourceLocator, "src/package.json#line:7");
  assert.deepEqual(matches[0]?.fact.attributes, { a: "first", z: "last" });
});

test("emits deterministic evidence order and exactly one coverage entry for each DEC-05 section", () => {
  const result = build([
    makeObservation({ analyzer: "javascript_node", category: "dependency", name: "zeta", value: "^1" }),
    makeObservation({ analyzer: "javascript_node", category: "dependency", name: "alpha", value: "^2" }),
  ]);
  const rerun = build([
    makeObservation({ analyzer: "javascript_node", category: "dependency", name: "alpha", value: "^2" }),
    makeObservation({ analyzer: "javascript_node", category: "dependency", name: "zeta", value: "^1" }),
  ]);

  assert.deepEqual(result, rerun);
  assert.deepEqual(result.coverage.map((entry) => [entry.sectionId, entry.profileField]),
    PROFILE_SECTIONS.map((section) => [section.id, section.field]));
  assert.equal(result.coverage.length, 16);
  const unspecified = result.coverage.find((entry) => entry.sectionId === "06");
  assert.equal(unspecified?.status, "not_specified");
  assert.deepEqual(result.evidence.filter((item) => item.profileField === "Dependencies").map((item) => item.fact.name), ["alpha", "zeta"]);
});

test("maps known observations to exact DEC-05 fields and leaves unsafe categories unmapped", () => {
  const cases: Array<[TechnicalObservation, string]> = [
    [makeObservation({ analyzer: "java_maven", category: "dependency", name: "org.example:core", value: "1.0" }), "Dependencies"],
    [makeObservation({ analyzer: "java_maven", category: "java_language_level", name: "release", value: "21" }), "Primary Language / Runtime"],
    [makeObservation({ analyzer: "javascript_node", category: "test_command", name: "npm test", value: "vitest run" }), "Build and Test"],
    [makeObservation({ analyzer: "docker", category: "docker_base_image", name: "base", value: "node:24" }), "Deployment / Infrastructure"],
    [makeObservation({ analyzer: "github_actions", category: "workflow_job", name: "test", value: "declared" }), "CI/CD"],
    [makeObservation({ analyzer: "docker", category: "compose_environment_variable", name: "PORT", value: "PORT" }), "Configuration / Environment Variables"],
    [makeObservation({ analyzer: "java_maven", category: "java_package", name: "Java package", value: "example.app" }), "Unmapped"],
  ];
  for (const [item, expected] of cases) {
    assert.equal(mapObservation(item).profileField, expected);
  }
  const unmapped = build([cases.at(-1)?.[0] as TechnicalObservation]);
  assert.equal(unmapped.evidence.find((item) => item.fact.value === "example.app")?.profileField, "Unmapped");
  assert.ok(unmapped.coverage.find((entry) => entry.sectionId === "15")?.evidenceIds.length);
});

test("keeps manifest, lockfile, source, and documentation authority relationships and explicit conflicts", () => {
  const packageMetadata = makeObservation({
    analyzer: "javascript_node", category: "package_name", name: "Package name", value: "canonical-name",
  });
  const readmeClaim = makeObservation({
    analyzer: "documentation", category: "package_name", name: "Documented project name", value: "readme-name",
    source: { path: "README.md", locator: "line:2", kind: "documentation" },
    claimType: "documentation_claim", verificationBasis: "documentation_claim", confidence: "Low",
  });
  const manifestDependency = makeObservation({
    analyzer: "javascript_node", category: "dependency", name: "zod", value: "^3.0.0",
    attributes: { versionKind: "declared_specifier" },
  });
  const lockDependency = makeObservation({
    analyzer: "javascript_node", category: "dependency", name: "zod", value: "3.4.1",
    attributes: { versionKind: "lockfile_resolved" },
    source: { path: "package-lock.json", locator: "packages[node_modules/zod].version", kind: "lockfile" },
  });
  const result = build([readmeClaim, lockDependency, manifestDependency, packageMetadata]);
  const metadataName = result.evidence.find((item) => item.profileField === "Application Name" && item.sourceType === "github_metadata");
  const manifestName = result.evidence.find((item) => item.profileField === "Application Name" && item.sourceType === "package_manifest");
  const readmeName = result.evidence.find((item) => item.profileField === "Application Name" && item.sourceType === "documentation");
  const declared = result.evidence.find((item) => item.fieldKey === "dependency:zod:declared");
  const resolved = result.evidence.find((item) => item.fieldKey === "dependency:zod:resolved");

  assert.equal(authorityRank("github_metadata"), 100);
  assert.equal(authorityRank("lockfile"), 90);
  assert.equal(authorityRank("manifest_configuration"), 80);
  assert.equal(authorityRank("source_code"), 60);
  assert.equal(authorityRank("documentation"), 40);
  assert.equal(metadataName?.status, "Verified");
  assert.equal(metadataName?.authorityRelation, "authoritative");
  assert.equal(manifestName?.status, "Conflict");
  assert.equal(manifestName?.authorityRelation, "overridden_by_authority");
  assert.equal(readmeName?.status, "Conflict");
  assert.equal(resolved?.sourceType, "package_lockfile");
  assert.equal(resolved?.authorityRelation, "authoritative");
  assert.equal(declared?.fact.value, "^3.0.0");
  assert.equal(declared?.status, "Verified");
  assert.equal(declared?.authorityRelation, "supporting");
  assert.notEqual(resolved?.fieldKey, declared?.fieldKey);
  const appCoverage = result.coverage.find((entry) => entry.sectionId === "01");
  assert.equal(appCoverage?.status, "supported_by_conflicting_evidence");
});

test("distinguishes Not Specified from Unable to Verify and preserves unsupported mentions", () => {
  const unsupported = makeObservation({
    analyzer: "documentation",
    category: "unsupported_technology",
    name: "Unsupported technology mention",
    value: "Python",
    status: "Unable to Verify",
    verificationBasis: "unsupported_technology_mention",
    confidence: "Low",
    source: { path: "README.md", locator: "line:3", kind: "documentation" },
    claimType: "documentation_claim",
  });
  const result = build([unsupported]);

  assert.equal(result.coverage.find((entry) => entry.sectionId === "06")?.status, "not_specified");
  const limitations = result.coverage.find((entry) => entry.sectionId === "15");
  assert.equal(limitations?.status, "unable_to_verify");
  const unsupportedEvidence = result.evidence.find((item) => item.fact.value === "Python");
  assert.equal(unsupportedEvidence?.profileField, "Limitations / Missing Information");
  assert.equal(unsupportedEvidence?.status, "Unable to Verify");
});

test("marks equally authoritative disagreements as peer conflicts", () => {
  const first = makeObservation({
    analyzer: "documentation",
    category: "configuration_reference",
    name: "maven.compiler.release",
    value: "17",
    source: { path: "config/a.properties", locator: "line:1", kind: "configuration" },
  });
  const second = makeObservation({
    analyzer: "documentation",
    category: "configuration_reference",
    name: "maven.compiler.release",
    value: "21",
    source: { path: "config/b.properties", locator: "line:4", kind: "configuration" },
  });
  const result = build([second, first]);
  const peerEvidence = result.evidence.filter((item) => item.fieldKey === "configuration:maven.compiler.release");

  assert.deepEqual(peerEvidence.map((item) => item.status), ["Conflict", "Conflict"]);
  assert.ok(peerEvidence.every((item) => item.authorityRelation === "peer_conflict"));
  assert.ok(peerEvidence.every((item) => item.conflictsWith.length === 1));
});

test("records excluded paths as coverage limitations without reading them into evidence", () => {
  const result = build([], filtered({
    status: "partial",
    fileRecords: [{ path: ".env", disposition: "excluded", reason: "sensitive_path" }],
    exclusionRecords: [{ path: ".env", disposition: "excluded", reason: "sensitive_path" }],
  }));

  assert.equal(result.evidence.some((item) => item.sourceLocator.includes(".env")), false);
  assert.equal(result.coverage.find((entry) => entry.sectionId === "08")?.status, "unable_to_verify");
  assert.ok(result.coverage.find((entry) => entry.sectionId === "08")?.issues.some((issue) => issue.code === "SENSITIVE_SOURCE_EXCLUDED"));
});

test("drops secret-shaped facts and malformed observations without propagating values", () => {
  const secretObservation = makeObservation({
    analyzer: "javascript_node",
    category: "package_description",
    name: "Package description",
    value: "SYNTHETIC_ONLY_TOKEN=DO_NOT_STORE_987",
  });
  const malformed = {
    analyzer: "javascript_node",
    category: "dependency",
    name: "bad path",
    value: "safe",
    source: { path: "../outside/package.json", locator: "line:1", kind: "manifest" },
    claimType: "declaration",
    status: "Verified",
    verificationBasis: "manifest_declaration",
    confidence: "High",
  } as unknown as TechnicalObservation;
  const invalidStatus = {
    ...makeObservation({ analyzer: "javascript_node", category: "package_name", name: "Package name", value: "bad status" }),
    status: "Secret leaked" as unknown as TechnicalObservation["status"],
  };
  const result = build([secretObservation, malformed, invalidStatus]);
  const serialized = JSON.stringify(result);

  assert.doesNotMatch(serialized, /DO_NOT_STORE_987/);
  assert.equal(result.issues.some((issue) => issue.code === "SENSITIVE_OBSERVATION_DROPPED"), true);
  assert.equal(result.issues.some((issue) => issue.code === "MALFORMED_OBSERVATION"), true);
  assert.equal(result.evidence.some((item) => item.sourceLocator.includes("outside")), false);
});

test("keeps analyzer errors typed and sanitized", () => {
  const issue: AnalyzerIssue = {
    analyzer: "java_maven",
    code: "INVALID_XML",
    path: "pom.xml",
  };
  const result = build([], filtered(), [issue]);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.issues, [{ code: "ANALYZER_ISSUE", analyzer: "java_maven", path: "pom.xml" }]);
  assert.ok(result.coverage.find((entry) => entry.sectionId === "15")?.issues.some((item) => item.code === "ANALYZER_INPUT_INVALID"));
  assert.doesNotMatch(serialized, /XML_PARSE|stack|source snippet/i);
});

test("rejects mismatched snapshots and all unsafe filter states", () => {
  assert.throws(() => buildEvidenceCatalog(filtered(), analysis([], [], { snapshotCommitSha: "b".repeat(40) }), {
    repositoryFullName: REPOSITORY_FULL_NAME,
  }), (error: unknown) => error instanceof EvidenceCatalogError && error.code === "SNAPSHOT_MISMATCH");
  assert.throws(() => buildEvidenceCatalog(filtered({ scan: {
    status: "incomplete", scanner: "test_double", expectedFileCount: 1, scannedFileCount: 0, coverageComplete: false,
  } }), analysis(), { repositoryFullName: REPOSITORY_FULL_NAME }),
  (error: unknown) => error instanceof EvidenceCatalogError && error.code === "UNSAFE_FILTERED_INPUT");
  assert.throws(() => buildEvidenceCatalog(
    filtered({ defaultBranch: "SYNTHETIC_ONLY_TOKEN=NO_METADATA_LEAK_123" }),
    analysis([], [], { defaultBranch: "SYNTHETIC_ONLY_TOKEN=NO_METADATA_LEAK_123" }),
    { repositoryFullName: REPOSITORY_FULL_NAME },
  ), (error: unknown) => error instanceof EvidenceCatalogError && error.code === "UNSAFE_FILTERED_INPUT");
});
