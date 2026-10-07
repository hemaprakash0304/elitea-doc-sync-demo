import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { composeTechnicalProfile } from "../src/composer.js";
import type { TechnicalObservation } from "../src/analyzers/types.js";
import { buildEvidenceCatalog } from "../src/evidence/catalog.js";
import { MAX_COLLECTION_FILE_BYTES, TECHNICAL_PROFILE_PATH, type CollectedFile, type ExistingProfileInput } from "../src/collection.js";
import type { RepositoryFilterResult } from "../src/filter.js";
import { reconcileTechnicalProfile } from "../src/reconciler.js";

const SNAPSHOT_SHA = "a".repeat(40);
const REPOSITORY_ID = "sample/reconcile";
const REPOSITORY_FULL_NAME = "sample/reconcile";
const DEFAULT_BRANCH = "release/next";

function obs(
  value: string,
  name = "Package name",
  category: TechnicalObservation["category"] = "package_name",
  status: TechnicalObservation["status"] = "Verified",
  confidence: TechnicalObservation["confidence"] = "High",
): TechnicalObservation {
  return {
    analyzer: "javascript_node",
    category,
    name,
    value,
    source: { path: "package.json", locator: "package.json:name", kind: "manifest" },
    claimType: "declaration",
    status,
    verificationBasis: "manifest_declaration",
    confidence,
  };
}

function createInputs(observations: TechnicalObservation[] = []) {
  const filteredResult = filtered();
  const catalog = buildEvidenceCatalog(filteredResult, {
    repositoryId: REPOSITORY_ID,
    defaultBranch: DEFAULT_BRANCH,
    snapshotCommitSha: SNAPSHOT_SHA,
    observations,
    issues: [],
  }, { repositoryFullName: REPOSITORY_FULL_NAME });
  return { filteredResult, catalog, composition: composeTechnicalProfile(catalog) };
}

function filtered(profile?: CollectedFile, safety?: "safe_to_parse" | "blocking_sensitive_finding" | "blocked_unavailable"): RepositoryFilterResult {
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
    existingProfile: profile === undefined
      ? { status: "absent" }
      : { status: safety ?? "safe_to_parse" },
  };
}

function existingProfile(content: string, overrides: Partial<CollectedFile> = {}): ExistingProfileInput {
  return {
    profilePresent: true,
    file: {
      path: TECHNICAL_PROFILE_PATH,
      extension: ".md",
      mode: "100644",
      kind: "regular",
      size: Buffer.byteLength(content, "utf8"),
      blobSha: "b".repeat(40),
      sourceCommitSha: SNAPSHOT_SHA,
      contentStatus: "text",
      content,
      ...overrides,
    },
  };
}

function makeManualProfile(candidate: string, rawNotes: string, sectionId: string): string {
  const endMarker = `<!-- docs-sync:generated:end section=${sectionId} -->`;
  const endIndex = candidate.indexOf(endMarker);
  assert.notEqual(endIndex, -1);
  const insertAt = endIndex + endMarker.length;
  return `${candidate.slice(0, insertAt)}\n\n${rawNotes}${candidate.slice(insertAt)}`;
}

function mutateSectionBody(candidate: string, sectionId: string, transform: (body: string) => string): string {
  const expression = new RegExp(
    `(<!-- docs-sync:generated:start section=${sectionId} schema=1 sha256=)[a-f0-9]{64}( -->\\n)([\\s\\S]*?)(<!-- docs-sync:generated:end section=${sectionId} -->)`,
  );
  const match = expression.exec(candidate);
  assert.ok(match);
  const body = transform(match[3] as string);
  const digest = createHash("sha256").update(body.replace(/\r\n/g, "\n"), "utf8").digest("hex");
  return candidate.replace(expression, `$1${digest}$2${body}$4`);
}

function profileFrom(candidate: string, safety: "safe_to_parse" | "blocking_sensitive_finding" | "blocked_unavailable" = "safe_to_parse") {
  const file = existingProfile(candidate);
  if (!file.profilePresent) {
    assert.fail("Expected existing profile fixture.");
  }
  return { filtered: filtered(file.file, safety), input: file };
}

test("treats an absent profile as first generation and returns the candidate unchanged", () => {
  const inputs = createInputs([obs("first-generation-app")]);
  const result = reconcileTechnicalProfile(inputs.filteredResult, { profilePresent: false }, inputs.catalog, inputs.composition);

  const sectionOne = inputs.composition.candidate.split("## 1. Application Name")[1]?.split("## 2. Description")[0];
  assert.equal(result.status, "FIRST_GENERATION", `${JSON.stringify(result.issues)}; ${sectionOne}`);
  assert.equal(result.candidate, inputs.composition.candidate);
  assert.equal(result.candidateSha256, inputs.composition.candidateSha256);
  assert.equal(result.existingProfilePreserved, false);
  assert.equal(result.preservedManualContent, false);
  assert.equal(result.additions.length > 0, true);
  assert.equal(result.issues.length, 0);
});

test("accepts a valid generated profile and returns NO_CHANGES for identical candidate bytes", () => {
  const inputs = createInputs([obs("stable-app")]);
  const profile = profileFrom(inputs.composition.candidate);

  const result = reconcileTechnicalProfile(profile.filtered, profile.input, inputs.catalog, inputs.composition);

  assert.equal(result.status, "NO_CHANGES");
  assert.equal(result.candidate, inputs.composition.candidate);
  assert.deepEqual(result.additions, []);
  assert.deepEqual(result.modifications, []);
  assert.deepEqual(result.removals, []);
  assert.equal(result.existingProfilePreserved, true);
});

test("reports field-level additions, modifications, and removals deterministically", () => {
  const oldInputs = createInputs([obs("old-name")]);
  const newInputs = createInputs([obs("new-name"), obs("new description", "Package description", "package_description")]);
  const old = profileFrom(oldInputs.composition.candidate);

  const result = reconcileTechnicalProfile(old.filtered, old.input, newInputs.catalog, newInputs.composition);

  assert.equal(result.status, "CHANGED");
  assert.ok(result.modifications.some((change) => change.sectionId === "01"));
  assert.ok(result.modifications.some((change) => change.sectionId === "02"));
  assert.ok(result.removals.length > 0);
  assert.deepEqual(result.additions, [...result.additions].sort((left, right) => left.sectionId.localeCompare(right.sectionId) || left.rowKey.localeCompare(right.rowKey)));
  assert.equal(result.candidate?.includes("## 16. Evidence / Verification Status"), true);
});

test("keeps unsupported or obsolete generated dependencies out and represents their status explicitly", () => {
  const oldInputs = createInputs([obs("^1.2.0", "legacy-lib", "dependency")]);
  const newInputs = createInputs([]);
  const old = profileFrom(oldInputs.composition.candidate);
  const result = reconcileTechnicalProfile(old.filtered, old.input, newInputs.catalog, newInputs.composition);

  assert.equal(result.status, "CHANGED");
  assert.ok(result.removals.some((change) => change.sectionId === "05" && change.before?.includes("legacy-lib")));
  assert.match(result.candidate ?? "", /Not Specified/);

  const unverifiable = createInputs([
    obs("17", "maven.compiler.release", "configuration_reference", "Unable to Verify", "Medium"),
  ]);
  assert.match(unverifiable.composition.candidate, /Unable to Verify/);
});

test("retains conflict evidence and emits Conflict in the reconciled candidate", () => {
  const oldInputs = createInputs([obs("single-name")]);
  const documentedName = obs("documented-name", "Documented project name", "package_name", "Verified", "Low");
  documentedName.analyzer = "documentation";
  documentedName.source = { path: "README.md", locator: "line:2", kind: "documentation" };
  documentedName.claimType = "documentation_claim";
  documentedName.verificationBasis = "documentation_claim";
  const newInputs = createInputs([obs("single-name"), documentedName]);
  const old = profileFrom(oldInputs.composition.candidate);

  const result = reconcileTechnicalProfile(old.filtered, old.input, newInputs.catalog, newInputs.composition);

  assert.equal(result.status, "CHANGED");
  assert.ok(result.conflicts.some((conflict) => conflict.profileField === "Application Name" && conflict.evidenceIds.length >= 2));
  assert.match(result.candidate ?? "", /\| Application Name \| Conflicting evidence; see Evidence \/ Verification Status \| Conflict \|/);
  assert.ok(result.candidate?.includes("documented-name"));
});

test("preserves an approved Human-maintained notes subsection byte-for-byte", () => {
  const oldInputs = createInputs([obs("notes-app")]);
  const newInputs = createInputs([obs("notes-app"), obs("description", "Package description", "package_description")]);
  const rawNotes = "### Human-maintained notes\r\nKeep  spacing, pipes |, and CRLF exactly.\r\n- manual note\r\n";
  const existing = makeManualProfile(oldInputs.composition.candidate, rawNotes, "01");
  const profile = profileFrom(existing);

  const result = reconcileTechnicalProfile(profile.filtered, profile.input, newInputs.catalog, newInputs.composition);

  assert.equal(result.status, "CHANGED", `${JSON.stringify(result.issues)}; ${existing.match(/^##\s+.*$/gm)?.join(" | ")}`);
  assert.equal(result.preservedManualContent, true);
  assert.ok(result.candidate?.includes(rawNotes));
  assert.equal(result.candidate?.match(/### Human-maintained notes/g)?.length, 1);
  assert.ok(result.modifications.some((change) => change.sectionId === "02"));
});

test("detects a valid marker/schema/16-section/digest structure before reconciliation", () => {
  const inputs = createInputs([obs("valid-profile")]);
  const profile = profileFrom(inputs.composition.candidate);
  const result = reconcileTechnicalProfile(profile.filtered, profile.input, inputs.catalog, inputs.composition);

  assert.equal(result.status, "NO_CHANGES");
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.candidate?.match(/^## /gm)?.length, 16);
  assert.equal(result.candidate?.match(/docs-sync:generated:start/g)?.length, 16);
});

test("blocks missing, invalid, duplicate, missing, or reordered profile markers and sections", () => {
  const inputs = createInputs([obs("structure-fixture")]);
  const original = inputs.composition.candidate;
  const cases: Array<[string, string, Partial<CollectedFile>?]> = [
    [original.replace("<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->", ""), "GLOBAL_MARKER_MISSING"],
    [original.replace("schema=1", "schema=99"), "MARKER_SCHEMA_UNSUPPORTED"],
    [original.replace("docs-sync:generated:start section=01", "docs-sync:generated:begin section=01"), "MARKER_MALFORMED"],
    [original.replace("## 1. Application Name\n", "## 1. Application Name\nUnmarked text has ambiguous ownership.\n"), "OWNERSHIP_AMBIGUOUS"],
    [original.replace(/## 6\. Database \/ Data Stores[\s\S]*?(?=## 7\.)/, ""), "SECTION_MISSING"],
    [original.replace("## 6. Database / Data Stores", "## 5. Dependencies\n\n<!-- duplicate -->\n\n## 6. Database / Data Stores"), "SECTION_DUPLICATE"],
    [original.replace("## 1. Application Name", "## 99. Unexpected"), "SECTION_ORDER_INVALID"],
  ];
  for (const [content, expected] of cases) {
    const profile = profileFrom(content);
    const result = reconcileTechnicalProfile(profile.filtered, profile.input, inputs.catalog, inputs.composition);
    assert.equal(result.candidate, undefined);
    assert.equal(result.existingProfilePreserved, true);
    assert.equal(result.issues[0]?.code, expected);
  }
});

test("returns NO_CHANGES when generated bytes match and identical manual notes are preserved", () => {
  const inputs = createInputs([obs("manual-noop-app")]);
  const rawNotes = "### Human-maintained notes\nManual text remains unchanged.\n";
  const existing = makeManualProfile(inputs.composition.candidate, rawNotes, "01");
  const profile = profileFrom(existing);

  const result = reconcileTechnicalProfile(profile.filtered, profile.input, inputs.catalog, inputs.composition);

  assert.equal(result.status, "NO_CHANGES");
  assert.equal(result.candidate, existing);
  assert.equal(result.preservedManualContent, true);
  assert.equal(result.candidate?.includes(rawNotes), true);
});

test("blocks malformed nesting, duplicate fields, digest mismatches, and modified generated blocks", () => {
  const inputs = createInputs([obs("malformed-fixture")]);
  const original = inputs.composition.candidate;
  const nested = original.replace(
    "| Application Name |",
    "<!-- docs-sync:generated:start section=01 schema=1 sha256=" + "0".repeat(64) + " -->\n| Application Name |",
  );
  const duplicateField = mutateSectionBody(original, "01", (body) =>
    body.replace("| Application Name |", "| Application Name |",) + "| Application Name | duplicate | Verified | — |\n",
  );
  const modifiedBody = original.replace("Not Specified", "tampered value");

  const tests: Array<[string, string]> = [
    [nested, "MARKER_MALFORMED"],
    [duplicateField, "DUPLICATE_FIELD"],
    [modifiedBody, "DIGEST_MISMATCH"],
  ];
  for (const [content, expected] of tests) {
    const profile = profileFrom(content);
    const result = reconcileTechnicalProfile(profile.filtered, profile.input, inputs.catalog, inputs.composition);
    if (expected === "NO_CHANGES") {
      assert.equal(result.status, "NO_CHANGES");
    } else {
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.issues[0]?.code, expected);
    }
  }
});

test("preserves existing profile bytes and blocks secret, oversized, unreadable, or unsafe profile states", () => {
  const inputs = createInputs([obs("safe-candidate")]);
  const secretValue = "SYNTHETIC_ONLY_TOKEN=NEVER_RETURN_PROFILE_SECRET_456";
  const secretProfile = makeManualProfile(inputs.composition.candidate, `### Human-maintained notes\n${secretValue}\n`, "01");
  const secretInput = profileFrom(secretProfile);
  const secretResult = reconcileTechnicalProfile(secretInput.filtered, secretInput.input, inputs.catalog, inputs.composition);
  assert.equal(secretResult.status, "BLOCKED");
  assert.equal(secretResult.issues[0]?.code, "PROFILE_SENSITIVE_CONTENT");
  assert.equal(secretResult.existingProfilePreserved, true);
  assert.equal(secretInput.input.profilePresent && secretInput.input.file.content, secretProfile);
  assert.doesNotMatch(JSON.stringify(secretResult), /NEVER_RETURN_PROFILE_SECRET_456/);

  const oversized = profileFrom(inputs.composition.candidate);
  oversized.input.profilePresent && (oversized.input.file.size = MAX_COLLECTION_FILE_BYTES + 1);
  const oversizedResult = reconcileTechnicalProfile(oversized.filtered, oversized.input, inputs.catalog, inputs.composition);
  assert.equal(oversizedResult.status, "BLOCKED");
  assert.equal(oversizedResult.issues[0]?.code, "PROFILE_SIZE_LIMIT");

  const unreadable = profileFrom(inputs.composition.candidate, "blocked_unavailable");
  const unreadableResult = reconcileTechnicalProfile(unreadable.filtered, unreadable.input, inputs.catalog, inputs.composition);
  assert.equal(unreadableResult.status, "BLOCKED");
  assert.equal(unreadableResult.issues[0]?.code, "FILTERED_INPUT_UNSAFE");
});

test("reports evidence ID refreshes and conflicts while remaining deterministic", () => {
  const existingInputs = createInputs([obs("same-app")]);
  const changedEvidence = obs("same-app");
  changedEvidence.source = { path: "package.json", locator: "package.json:name#changed-source", kind: "manifest" };
  const newInputs = createInputs([changedEvidence]);
  const existing = profileFrom(existingInputs.composition.candidate);
  const first = reconcileTechnicalProfile(existing.filtered, existing.input, newInputs.catalog, newInputs.composition);
  const second = reconcileTechnicalProfile(existing.filtered, existing.input, newInputs.catalog, newInputs.composition);

  assert.equal(first.status, "CHANGED");
  assert.deepEqual(first, second);
  assert.ok(first.modifications.some((change) => change.sectionId === "01"));
  assert.deepEqual(first.conflicts, second.conflicts);
});
