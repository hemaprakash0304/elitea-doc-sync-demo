import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { composeTechnicalProfile } from "../src/composer.js";
import { buildEvidenceCatalog } from "../src/evidence/catalog.js";
import type { CollectedFile } from "../src/collection.js";
import { validateReconciledCandidate, type ValidationInput } from "../src/validation.js";
import type { RepositoryFilterResult, SecretScanInputFile, SecretScanOutcome, SecretScanner } from "../src/filter.js";
import type { ProfileReconciliationResult } from "../src/reconciler.js";
import type { TechnicalObservation } from "../src/analyzers/types.js";

const SNAPSHOT_SHA = "a".repeat(40);
const REPOSITORY_ID = "sample/validation";
const REPOSITORY_FULL_NAME = "sample/validation";
const DEFAULT_BRANCH = "release/next";

class SyntheticScanner implements SecretScanner {
  readonly id = "test_double" as const;
  readonly executionBoundary = "local" as const;
  outcome?: SecretScanOutcome;
  calls = 0;

  async scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    this.calls += 1;
    if (this.outcome !== undefined) return this.outcome;
    const findings = files.flatMap((file) => /SYNTHETIC_ONLY_(?:TOKEN|SECRET)=([A-Za-z0-9_-]+)/.test(file.content)
      ? [{ path: file.path, ruleId: "synthetic_test_rule", severity: "high" as const }]
      : []);
    return { status: "complete", scannedFileCount: files.length, findings };
  }
}

function filtered(profile?: CollectedFile, overrides: Partial<RepositoryFilterResult> = {}): RepositoryFilterResult {
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
      expectedFileCount: profile === undefined ? 0 : 1,
      scannedFileCount: profile === undefined ? 0 : 1,
      coverageComplete: true,
    },
    existingProfile: profile === undefined ? { status: "absent" } : { status: "safe_to_parse" },
    ...overrides,
  };
}

function observation(
  category: TechnicalObservation["category"],
  name: string,
  value: string,
  overrides: Partial<TechnicalObservation> = {},
): TechnicalObservation {
  return {
    analyzer: "javascript_node",
    category,
    name,
    value,
    source: { path: "package.json", locator: `package.json:${name}`, kind: "manifest" },
    claimType: "declaration",
    status: "Verified",
    verificationBasis: "manifest_declaration",
    confidence: "High",
    ...overrides,
  };
}

function createValidInput(observations: TechnicalObservation[] = []): ValidationInput {
  const filteredInput = filtered();
  const catalog = buildEvidenceCatalog(filteredInput, {
    repositoryId: REPOSITORY_ID,
    defaultBranch: DEFAULT_BRANCH,
    snapshotCommitSha: SNAPSHOT_SHA,
    observations,
    issues: [],
  }, { repositoryFullName: REPOSITORY_FULL_NAME });
  const composition = composeTechnicalProfile(catalog);
  const reconciliation: ProfileReconciliationResult = {
    status: "FIRST_GENERATION",
    repositoryId: REPOSITORY_ID,
    defaultBranch: DEFAULT_BRANCH,
    snapshotCommitSha: SNAPSHOT_SHA,
    candidate: composition.candidate,
    candidateSha256: composition.candidateSha256,
    schemaVersion: 1,
    additions: [],
    modifications: [],
    removals: [],
    conflicts: [],
    preservedManualContent: false,
    existingProfilePreserved: false,
    issues: [],
  };
  return { filtered: filteredInput, catalog, composition, reconciliation, scanner: new SyntheticScanner() };
}

function withCandidate(input: ValidationInput, candidate: string): ValidationInput {
  return {
    ...input,
    reconciliation: {
      ...input.reconciliation,
      candidate,
      candidateSha256: sha256(candidate),
    },
  };
}

function mutateSection(input: ValidationInput, sectionId: string, transform: (body: string) => string): ValidationInput {
  const expression = new RegExp(
    `(<!-- docs-sync:generated:start section=${sectionId} schema=1 sha256=)[a-f0-9]{64}( -->\\n)([\\s\\S]*?)(<!-- docs-sync:generated:end section=${sectionId} -->)`,
  );
  const match = expression.exec(input.reconciliation.candidate ?? "");
  assert.ok(match);
  const body = transform(match[3] as string);
  const digest = sha256(body);
  const updated = (input.reconciliation.candidate as string).replace(expression, `$1${digest}$2${body}$4`);
  return withCandidate(input, updated);
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

test("passes a complete, evidence-bound, scanned first-generation candidate", async () => {
  const input = createValidInput([observation("package_name", "Package name", "validation-app")]);
  const result = await validateReconciledCandidate(input);

  assert.equal(result.status, "PASS", JSON.stringify(result.blockingFailures.map((issue) => issue.code)));
  assert.equal(result.snapshotCommitSha, SNAPSHOT_SHA);
  assert.equal(result.candidateSha256, input.reconciliation.candidateSha256);
  assert.equal(result.checks.length, 15);
  assert.ok(result.checks.every((check) => check.status === "PASS"));
  assert.deepEqual(result.blockingFailures, []);
  assert.equal((input.scanner as SyntheticScanner).calls, 1);
});

test("blocks safely when the local candidate scanner is unavailable or incomplete", async () => {
  const input = createValidInput();
  const unavailable: SecretScanner = {
    id: "unavailable",
    executionBoundary: "local",
    scan: async () => ({ status: "failed", scannedFileCount: 0, findings: [], errorCode: "SCANNER_UNAVAILABLE" }),
  };
  const unavailableResult = await validateReconciledCandidate({ ...input, scanner: unavailable });
  assert.equal(unavailableResult.status, "BLOCKED");
  assert.equal(unavailableResult.checks.find((check) => check.id === "SECURITY_SCAN")?.status, "BLOCKED");

  const incomplete = new SyntheticScanner();
  incomplete.outcome = { status: "incomplete", scannedFileCount: 0, findings: [], errorCode: "SCAN_INCOMPLETE" };
  const incompleteResult = await validateReconciledCandidate({ ...input, scanner: incomplete });
  assert.equal(incompleteResult.status, "BLOCKED");
  assert.ok(incompleteResult.blockingFailures.some((issue) => issue.code === "SCANNER_INCOMPLETE"));
});

test("fails invalid structure, section ordering, ownership markers, schema, and table headers", async () => {
  const input = createValidInput();
  const candidate = input.reconciliation.candidate as string;
  const missingSection = candidate.replace(/## 6\. Database \/ Data Stores[\s\S]*?(?=## 7\.)/, "");
  const reordered = candidate.replace("## 1. Application Name", "## 2. Description");
  const missingMarker = candidate.replace("<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->", "");
  const invalidSchema = candidate.replace("schema=1", "schema=2");
  const invalidTable = mutateSection(input, "01", (body) => body.replace("| Field | Value | Status | Evidence IDs |", "| wrong | columns |"));

  for (const [bad, code] of [
    [missingSection, "SECTION_MISSING"],
    [reordered, "SECTION_ORDER_INVALID"],
    [missingMarker, "GENERATED_MARKER_INVALID"],
    [invalidSchema, "OWNERSHIP_MARKER_INVALID"],
    [invalidTable.reconciliation.candidate as string, "TABLE_SCHEMA_INVALID"],
  ] as const) {
    const result = await validateReconciledCandidate(withCandidate(input, bad));
    assert.equal(result.status, "FAIL");
    assert.ok(result.blockingFailures.some((issue) => issue.code === code), code);
  }
});

test("fails unknown evidence references and incomplete coverage", async () => {
  const input = createValidInput([observation("package_name", "Package name", "catalog-name")]);
  const badReference = mutateSection(input, "01", (body) => body.replace(/E[0-9A-F]{64}/, `E${"F".repeat(64)}`));
  const badReferenceResult = await validateReconciledCandidate(badReference);
  assert.ok(badReferenceResult.blockingFailures.some((issue) => issue.code === "EVIDENCE_ID_UNKNOWN"));

  const missingCoverage = {
    ...input,
    catalog: { ...input.catalog, coverage: input.catalog.coverage.slice(1) },
  };
  const coverageResult = await validateReconciledCandidate(missingCoverage);
  assert.ok(coverageResult.blockingFailures.some((issue) => issue.code === "COVERAGE_ENTRY_MISSING"));
  assert.equal(input.catalog.coverage.find((entry) => entry.sectionId === "06")?.status, "not_specified");
});

test("accepts Unable to Verify when catalog coverage records an excluded source", async () => {
  const input = createValidInput();
  const catalog = {
    ...input.catalog,
    coverage: input.catalog.coverage.map((entry) => entry.sectionId === "03"
      ? { ...entry, status: "unable_to_verify" as const, issues: [{ code: "SENSITIVE_SOURCE_EXCLUDED" as const, count: 1 }] }
      : entry),
  };
  const composition = composeTechnicalProfile(catalog);
  const reconciliation = {
    ...input.reconciliation,
    candidate: composition.candidate,
    candidateSha256: composition.candidateSha256,
  };
  const result = await validateReconciledCandidate({ ...input, catalog, composition, reconciliation });

  assert.equal(result.status, "PASS", JSON.stringify(result.blockingFailures.map((issue) => issue.code)));
  assert.match(composition.candidate, /Unable to Verify/);
});

test("rejects snapshot mismatch, reconciliation failure, and candidate digest mismatch", async () => {
  const input = createValidInput();
  const wrongSnapshot = {
    ...input,
    reconciliation: { ...input.reconciliation, snapshotCommitSha: "b".repeat(40) },
  };
  const snapshotResult = await validateReconciledCandidate(wrongSnapshot);
  assert.equal(snapshotResult.status, "BLOCKED");
  assert.ok(snapshotResult.blockingFailures.some((issue) => issue.code === "SNAPSHOT_MISMATCH"));

  const blockedReconciliation = {
    ...input,
    reconciliation: {
      status: "BLOCKED" as const,
      repositoryId: input.reconciliation.repositoryId,
      defaultBranch: input.reconciliation.defaultBranch,
      snapshotCommitSha: input.reconciliation.snapshotCommitSha,
      schemaVersion: input.reconciliation.schemaVersion,
      additions: [],
      modifications: [],
      removals: [],
      conflicts: [],
      preservedManualContent: false,
      existingProfilePreserved: false,
      issues: [],
    },
  };
  const blockedResult = await validateReconciledCandidate(blockedReconciliation);
  assert.equal(blockedResult.status, "BLOCKED");
  assert.ok(blockedResult.checks.some((check) => check.status === "NOT_RUN"));

  const badDigest = {
    ...input,
    reconciliation: { ...input.reconciliation, candidateSha256: "0".repeat(64) },
  };
  const digestResult = await validateReconciledCandidate(badDigest);
  assert.equal(digestResult.status, "FAIL");
  assert.ok(digestResult.blockingFailures.some((issue) => issue.code === "CANDIDATE_DIGEST_MISMATCH"));
});

test("rejects invalid changed-file boundaries and profile-preservation claims", async () => {
  const input = createValidInput();
  const changedBoundary = {
    ...input,
    reconciliation: {
      ...input.reconciliation,
      status: "NO_CHANGES" as const,
      additions: [{
        operation: "addition" as const,
        sectionId: "01" as const,
        section: "Application Name",
        rowKey: "unexpected-addition",
        evidenceIds: [],
      }],
    },
  };
  const boundaryResult = await validateReconciledCandidate(changedBoundary);
  assert.ok(boundaryResult.blockingFailures.some((issue) => issue.code === "CHANGED_FILE_BOUNDARY"));
  assert.equal("candidate" in boundaryResult, false);

  const preservationMismatch = {
    ...input,
    reconciliation: { ...input.reconciliation, existingProfilePreserved: true },
  };
  const preservationResult = await validateReconciledCandidate(preservationMismatch);
  assert.ok(preservationResult.blockingFailures.some((issue) => issue.code === "PROFILE_PRESERVATION_INVALID"));
  assert.equal("candidate" in preservationResult, false);
});

test("blocks synthetic secrets and rejects unsupported candidate claims", async () => {
  const input = createValidInput();
  const candidate = input.reconciliation.candidate as string;
  const withSecret = withCandidate(input, candidate.replace("# Technical Profile", "# Technical Profile\nSYNTHETIC_ONLY_TOKEN=VALIDATION_TEST_VALUE"));
  const secretResult = await validateReconciledCandidate(withSecret);
  assert.equal(secretResult.status, "BLOCKED");
  assert.ok(secretResult.blockingFailures.some((issue) => issue.code === "SENSITIVE_VALUE_FOUND" || issue.code === "SECRET_FOUND"));
  assert.doesNotMatch(JSON.stringify(secretResult), /VALIDATION_TEST_VALUE/);

  const unsupported = withCandidate(input, candidate.replace("# Technical Profile", "# Technical Profile\nProduction Node.js runtime version 24"));
  const unsupportedResult = await validateReconciledCandidate(unsupported);
  assert.ok(unsupportedResult.blockingFailures.some((issue) => issue.code === "UNSUPPORTED_CLAIM"));
});
