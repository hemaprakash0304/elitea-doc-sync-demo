import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { composeTechnicalProfile, ProfileComposerError } from "../src/composer.js";
import { PROFILE_SECTIONS, type CoverageEntry, type EvidenceCatalogResult, type EvidenceItem, type ProfileField, type ProfileSectionId } from "../src/evidence/types.js";

const SNAPSHOT_SHA = "a".repeat(40);

function evidenceItem(
  index: number,
  sectionId: ProfileSectionId | null,
  profileField: ProfileField,
  name: string,
  value: string,
  options: Partial<EvidenceItem> = {},
): EvidenceItem {
  const evidenceId = `E${index.toString(16).toUpperCase().padStart(64, "0")}`;
  return {
    evidenceId,
    sectionId,
    profileField,
    fieldKey: options.fieldKey ?? `${sectionId ?? "unmapped"}:${name.toLowerCase()}`,
    sourceType: options.sourceType ?? "package_manifest",
    sourceLocator: options.sourceLocator ?? "package.json:name",
    fact: { name, value, ...(options.fact?.attributes === undefined ? {} : { attributes: options.fact.attributes }) },
    status: options.status ?? "Verified",
    verificationBasis: options.verificationBasis ?? "manifest_declaration",
    confidence: options.confidence ?? "High",
    authority: options.authority ?? "manifest_configuration",
    authorityRelation: options.authorityRelation ?? "supporting",
    conflictsWith: options.conflictsWith ?? [],
  };
}

function coverageFor(evidence: readonly EvidenceItem[]): CoverageEntry[] {
  return PROFILE_SECTIONS.map((section) => {
    const sectionEvidence = evidence.filter((item) => item.sectionId === section.id ||
      (section.id === "15" && item.profileField === "Unmapped"));
    const verifiedEvidenceIds = sectionEvidence.filter((item) => item.status === "Verified").map((item) => item.evidenceId);
    const conflictingEvidenceIds = sectionEvidence.filter((item) => item.status === "Conflict").map((item) => item.evidenceId);
    const unverifiableEvidenceIds = sectionEvidence.filter((item) => item.status === "Unable to Verify").map((item) => item.evidenceId);
    const status = conflictingEvidenceIds.length > 0
      ? "supported_by_conflicting_evidence" as const
      : verifiedEvidenceIds.length > 0
        ? "supported_by_verified_evidence" as const
        : unverifiableEvidenceIds.length > 0
          ? "unable_to_verify" as const
          : "not_specified" as const;
    return {
      sectionId: section.id,
      profileField: section.field,
      status,
      evidenceIds: sectionEvidence.map((item) => item.evidenceId),
      verifiedEvidenceIds,
      conflictingEvidenceIds,
      unverifiableEvidenceIds,
      issues: [],
    };
  });
}

function catalog(evidence: EvidenceItem[] = []): EvidenceCatalogResult {
  return {
    repositoryId: "sample/composer",
    defaultBranch: "release",
    snapshotCommitSha: SNAPSHOT_SHA,
    evidence,
    coverage: coverageFor(evidence),
    issues: [],
  };
}

function tableBody(candidate: string, sectionId: ProfileSectionId): { markerDigest: string; body: string } {
  const expression = new RegExp(
    `<!-- docs-sync:generated:start section=${sectionId} schema=1 sha256=([a-f0-9]{64}) -->\\n([\\s\\S]*?)<!-- docs-sync:generated:end section=${sectionId} -->`,
  );
  const match = expression.exec(candidate);
  assert.ok(match, `Missing generated block ${sectionId}`);
  return { markerDigest: match[1] as string, body: match[2] as string };
}

test("renders exactly the DEC-05 headings in order with all DEC-06 generated blocks and matching digests", () => {
  const result = composeTechnicalProfile(catalog());
  const headings = [...result.candidate.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

  assert.match(result.candidate, /^# Technical Profile\n/m);
  assert.ok(result.candidate.includes("<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->"));
  assert.deepEqual(headings, PROFILE_SECTIONS.map((section, index) => `${index + 1}. ${section.field}`));
  assert.equal((result.candidate.match(/docs-sync:generated:start/g) ?? []).length, 16);
  assert.equal((result.candidate.match(/docs-sync:generated:end/g) ?? []).length, 16);
  for (const section of PROFILE_SECTIONS) {
    const block = tableBody(result.candidate, section.id);
    const digest = createHash("sha256").update(block.body.replace(/\r\n/g, "\n"), "utf8").digest("hex");
    assert.equal(block.markerDigest, digest, section.id);
    assert.equal(result.sectionDigests[section.id], digest);
    assert.ok(block.body.startsWith("| "));
    assert.ok(block.body.endsWith("\n"));
  }
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.candidate.endsWith("\n"), true);
});

test("renders explicit Not Specified rows and Unable to Verify coverage without inventing values", () => {
  const source = evidenceItem(1, "03", "Primary Language / Runtime", "Java source level", "21", {
    fieldKey: "java_language_level:maven.compiler.release",
    status: "Verified",
    verificationBasis: "manifest_declaration",
  });
  const catalogInput = catalog([source]);
  const result = composeTechnicalProfile(catalogInput);
  const language = tableBody(result.candidate, "03").body;
  const description = tableBody(result.candidate, "02").body;

  assert.match(language, /Java source\/release configuration/);
  assert.match(language, /\| Runtime\(s\) \| Not Specified \| Unable to Verify \| — \|/);
  assert.match(description, /\| Description \| Not Specified \| Not Specified \| — \|/);
  assert.doesNotMatch(result.candidate, /production runtime|JDK 21/);
});

test("preserves declared and resolved dependency facts with separate traceable evidence IDs", () => {
  const declared = evidenceItem(2, "05", "Dependencies", "zod", "^3.0.0", {
    fieldKey: "dependency:zod:declared",
    sourceType: "package_manifest",
    fact: { name: "zod", value: "^3.0.0", attributes: { scope: "dependencies", versionKind: "declared_specifier" } },
  });
  const resolved = evidenceItem(3, "05", "Dependencies", "zod", "3.4.1", {
    fieldKey: "dependency:zod:resolved",
    sourceType: "package_lockfile",
    fact: { name: "zod", value: "3.4.1", attributes: { versionKind: "lockfile_resolved" } },
    verificationBasis: "lockfile_resolution",
    authority: "lockfile",
    authorityRelation: "authoritative",
  });
  const body = tableBody(composeTechnicalProfile(catalog([declared, resolved])).candidate, "05").body;

  assert.match(body, /\| zod \| dependencies \| \^3\.0\.0 \| 3\.4\.1 \| Verified \| E[0-9A-F]{64}, E[0-9A-F]{64} \|/);
});

test("emits only environment variable names and never composes values", () => {
  const variable = evidenceItem(4, "08", "Configuration / Environment Variables", "Workflow environment variable name", "APP_TOKEN", {
    fieldKey: "environment_variable:app_token",
    sourceType: "workflow",
    fact: { name: "Workflow environment variable name", value: "APP_TOKEN" },
  });
  const result = composeTechnicalProfile(catalog([variable]));
  const body = tableBody(result.candidate, "08").body;

  assert.match(body, /\| APP\\_TOKEN \| Not Specified \| Verified \| E[0-9A-F]{64} \|/);
  assert.doesNotMatch(body, /token-value|password-value|api-key-value/);
});

test("renders conflicts, unsupported facts, limitations, and traceable evidence rows", () => {
  const conflict = evidenceItem(5, "01", "Application Name", "Package name", "manifest-app", {
    fieldKey: "application_name",
    status: "Conflict",
    authorityRelation: "overridden_by_authority",
    conflictsWith: [`E${6 .toString(16).toUpperCase().padStart(64, "0")}`],
  });
  const repositoryName = evidenceItem(6, "01", "Application Name", "Repository name", "sample/reconcile", {
    fieldKey: "application_name",
    sourceType: "github_metadata",
    verificationBasis: "github_repository_metadata",
    authority: "github_metadata",
    authorityRelation: "authoritative",
  });
  const unsupported = evidenceItem(7, "15", "Limitations / Missing Information", "Unsupported technology mention", "Python", {
    fieldKey: "unsupported_technology:python",
    status: "Unable to Verify",
    confidence: "Low",
    verificationBasis: "unsupported_technology_mention",
    sourceType: "documentation",
  });
  const output = composeTechnicalProfile(catalog([conflict, repositoryName, unsupported])).candidate;

  assert.match(tableBody(output, "01").body, /\| Application Name \| Conflicting evidence; see Evidence \/ Verification Status \| Conflict \| E[0-9A-F]{64}, E[0-9A-F]{64} \|/);
  assert.ok(tableBody(output, "16").body.includes("manifest-app"));
  assert.ok(tableBody(output, "16").body.includes("sample/reconcile"));
  assert.match(tableBody(output, "15").body, /Unsupported technology mention/);
  assert.match(tableBody(output, "15").body, /Unable to Verify/);
  assert.match(tableBody(output, "16").body, /Source type/);
  assert.match(tableBody(output, "16").body, /Confidence/);
});

test("escapes repository-controlled Markdown table content and rejects secret-shaped evidence", () => {
  const escaped = evidenceItem(7, "02", "Description", "Package description", "Use <script>alert(1)</script> | `unsafe`", {
    fieldKey: "description",
    sourceType: "package_manifest",
  });
  const candidate = composeTechnicalProfile(catalog([escaped])).candidate;
  assert.doesNotMatch(candidate, /<script>/);
  assert.match(candidate, /&lt;script&gt;/);
  assert.match(candidate, /\\\|/);

  const unsafe = evidenceItem(8, "02", "Description", "Package description", "SYNTHETIC_ONLY_TOKEN=DO_NOT_RENDER_123", {
    fieldKey: "description",
  });
  assert.throws(() => composeTechnicalProfile(catalog([unsafe])),
    (error: unknown) => error instanceof ProfileComposerError && error.code === "UNSAFE_EVIDENCE");
});

test("composition is deterministic and does not use timestamps or random identifiers", () => {
  const input = catalog([
    evidenceItem(9, "05", "Dependencies", "zeta", "^1", { fieldKey: "dependency:zeta:declared" }),
    evidenceItem(10, "05", "Dependencies", "alpha", "^2", { fieldKey: "dependency:alpha:declared" }),
  ]);
  const first = composeTechnicalProfile(input);
  const second = composeTechnicalProfile(input);

  assert.deepEqual(first, second);
  assert.equal(first.candidateSha256, createHash("sha256").update(first.candidate, "utf8").digest("hex"));
  assert.doesNotMatch(first.candidate, /\b(?:generated at|timestamp|Date\(|randomUUID|process\.pid)\b/i);
  assert.ok(first.candidate.indexOf("| alpha |") < first.candidate.indexOf("| zeta |"));
});

test("rejects missing, reordered, or malformed coverage before producing a candidate", () => {
  const complete = catalog();
  assert.throws(() => composeTechnicalProfile({ ...complete, coverage: complete.coverage.slice(1) }),
    (error: unknown) => error instanceof ProfileComposerError && error.code === "INVALID_COVERAGE");
  assert.throws(() => composeTechnicalProfile({
    ...complete,
    coverage: [complete.coverage[1] as CoverageEntry, complete.coverage[0] as CoverageEntry, ...complete.coverage.slice(2)],
  }), (error: unknown) => error instanceof ProfileComposerError && error.code === "INVALID_COVERAGE");
  assert.throws(() => composeTechnicalProfile({ ...complete, snapshotCommitSha: "not-a-commit" }),
    (error: unknown) => error instanceof ProfileComposerError && error.code === "INVALID_EVIDENCE_CATALOG");
});
