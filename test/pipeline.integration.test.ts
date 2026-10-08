import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { RunConfiguration } from "../src/config.js";
import { TECHNICAL_PROFILE_PATH } from "../src/collection.js";
import { coordinateRun, type CoordinatorResult } from "../src/coordinator.js";
import type { GitHubReadClient, GitHubRepositoryMetadata, GitHubTreeEntry } from "../src/github-client.js";
import { PROFILE_SECTIONS } from "../src/evidence/types.js";
import { AUTOMATED_TEST_SUITE_VERSION, type AutomatedTestBinding, type AutomatedTestResult } from "../src/gate.js";
import type { SecretScanInputFile, SecretScanOutcome, SecretScanner } from "../src/filter.js";
import type { ProposalWriteCapability, ProposalWriteClient } from "../src/proposal.js";

const CONFIGURATION: RunConfiguration = {
  targetRepository: "Sample/EliteA-Pipeline-Fixture",
  normalizedRepositoryId: "sample/elitea-pipeline-fixture",
  executionContext: "local",
};
const DEFAULT_BRANCH = "release/next";
const FIRST_COMMIT = "a".repeat(40);
const SECOND_COMMIT = "d".repeat(40);
const FIXED_RUN_ID = "00000000-0000-4000-8000-000000000012";
const FIXED_TIME = new Date("2026-10-08T12:00:00.000Z");
function passingTestResult(binding: AutomatedTestBinding): AutomatedTestResult {
  return {
    status: "PASS",
    suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
    totalTests: 188,
    passedTests: 188,
    failedTests: 0,
    skippedTests: 0,
    binding,
  };
}

interface SnapshotCalls {
  metadata: number;
  branches: string[];
  trees: string[];
  blobs: string[];
}

interface SnapshotFixture {
  client: GitHubReadClient;
  files: Map<string, string>;
  originalFiles: Map<string, string>;
  calls: SnapshotCalls;
  scanner: SyntheticScanner;
}

class SyntheticScanner implements SecretScanner {
  readonly id = "test_double" as const;
  readonly executionBoundary = "local" as const;
  readonly version = "test-double/1";
  readonly scannedPaths: string[][] = [];
  failOnCall?: number;

  async scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    this.scannedPaths.push(files.map((file) => file.path));
    if (this.failOnCall === this.scannedPaths.length) {
      return { status: "failed", scannedFileCount: 0, findings: [], errorCode: "SCANNER_FAILED" };
    }
    const findings = files.flatMap((file) => /SYNTHETIC_ONLY_(?:TOKEN|SECRET)=/.test(file.content)
      ? [{ path: file.path, ruleId: "synthetic_test_rule", severity: "high" as const }]
      : []);
    return { status: "complete", scannedFileCount: files.length, findings };
  }
}

function syntheticProposalClient(): ProposalWriteClient {
  const capability: ProposalWriteCapability = {
    provider: "dedicated_github_proposal_app",
    normalizedRepositoryId: CONFIGURATION.normalizedRepositoryId,
    repositoryId: 42,
    permissions: {
      contents: "write",
      pullRequests: "write",
      canApprove: false,
      canMerge: false,
      canBypassBranchProtection: false,
      canWriteDefaultBranch: false,
    },
    branchProtection: { pullRequestRequired: true, humanApprovalRequired: true, proposalAppBypass: false },
  };
  return {
    capability,
    createFeatureBranch: async (input) => ({ status: "CREATED", branchName: input.branchName, baseCommitSha: input.baseCommitSha }),
    commitSingleProfileFile: async (input) => ({
      commitSha: "c".repeat(40),
      parentCommitSha: input.baseCommitSha,
      treeSha: "d".repeat(40),
      changedPaths: [input.path],
      profileSha256: sha256(input.content),
    }),
    getBranchHead: async (input) => ({ branchName: input.branchName, commitSha: "c".repeat(40) }),
    createPullRequest: async (input) => ({
      number: 1,
      url: "https://github.com/Sample/EliteA-Pipeline-Fixture/pull/1",
      state: "open",
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
    }),
    closePullRequest: async () => true,
  };
}

function snapshotFixture(
  sourceFiles: Readonly<Record<string, string>>,
  commitSha = FIRST_COMMIT,
  scanner = new SyntheticScanner(),
): SnapshotFixture {
  const files = new Map(Object.entries(sourceFiles).sort(([left], [right]) => compareText(left, right)));
  const originalFiles = new Map(files);
  const blobs = new Map<string, Buffer>();
  const pathsByBlob = new Map<string, string>();
  const entries: GitHubTreeEntry[] = [...files].map(([path, content]) => {
    const bytes = Buffer.from(content, "utf8");
    const blobSha = gitBlobSha(bytes);
    blobs.set(blobSha, bytes);
    pathsByBlob.set(blobSha, path);
    return { path, mode: "100644", type: "blob", sha: blobSha, size: bytes.length };
  });
  const treeSha = createHash("sha1").update(JSON.stringify(entries), "utf8").digest("hex");
  const calls: SnapshotCalls = { metadata: 0, branches: [], trees: [], blobs: [] };
  const repository: GitHubRepositoryMetadata = {
    repositoryId: 42,
    normalizedRepositoryId: CONFIGURATION.normalizedRepositoryId,
    fullName: "Sample/EliteA-Pipeline-Fixture",
    isPrivate: false,
    defaultBranch: DEFAULT_BRANCH,
    readRetryCount: 0,
  };
  const client: GitHubReadClient = {
    getRepositoryMetadata: async () => {
      calls.metadata += 1;
      return repository;
    },
    getDefaultBranchCommit: async (_configuration, branch) => {
      calls.branches.push(branch);
      return { branch, commitSha, treeSha, readRetryCount: 0 };
    },
    getRepositoryTree: async (_configuration, requestedTreeSha) => {
      calls.trees.push(requestedTreeSha);
      return { treeSha: requestedTreeSha, entries, truncated: false, readRetryCount: 0 };
    },
    getGitBlob: async (_configuration, blobSha) => {
      calls.blobs.push(pathsByBlob.get(blobSha) ?? "[unknown-blob]");
      const bytes = blobs.get(blobSha);
      if (bytes === undefined) {
        throw new Error("Unexpected blob requested by integration fixture.");
      }
      return {
        sha: blobSha,
        size: bytes.length,
        encoding: "base64",
        content: bytes.toString("base64"),
        readRetryCount: 0,
      };
    },
  };
  return { client, files, originalFiles, calls, scanner };
}

function nodeProject(dependencies: Record<string, string> = {}): string {
  return JSON.stringify({
    name: "pipeline-app",
    description: "Synthetic pipeline fixture",
    engines: { node: ">=24" },
    dependencies,
    scripts: { test: "node --test" },
  }, null, 2);
}

async function runSnapshot(
  sourceFiles: Readonly<Record<string, string>>,
  commitSha = FIRST_COMMIT,
  scanner = new SyntheticScanner(),
): Promise<{ fixture: SnapshotFixture; result: CoordinatorResult }> {
  const fixture = snapshotFixture(sourceFiles, commitSha, scanner);
  const result = await coordinateRun(CONFIGURATION, {
    createRunId: () => FIXED_RUN_ID,
    now: () => FIXED_TIME,
    githubClient: fixture.client,
    secretScanner: fixture.scanner,
    automatedTests: (binding: AutomatedTestBinding) => passingTestResult(binding),
    automatedTestTimeoutMs: 100,
    proposalWriteClient: syntheticProposalClient(),
  });
  return { fixture, result };
}

function requireSuccess(result: CoordinatorResult): Extract<CoordinatorResult, { ok: true }> {
  if (!result.ok) {
    assert.fail(`Pipeline failed: ${result.error.code}; proposal=${result.proposal?.failureCode ?? "none"}; gate=${result.gate?.blockingFailures.map((failure) => failure.code).join(",") ?? "not-run"}`);
  }
  return result;
}

function profileSection(candidate: string, sectionId: string): string {
  const sectionIndex = PROFILE_SECTIONS.findIndex((section) => section.id === sectionId);
  assert.notEqual(sectionIndex, -1);
  const heading = `## ${sectionIndex + 1}. ${PROFILE_SECTIONS[sectionIndex]?.field}`;
  const start = candidate.indexOf(heading);
  assert.notEqual(start, -1);
  const next = PROFILE_SECTIONS[sectionIndex + 1];
  const end = next === undefined
    ? candidate.length
    : candidate.indexOf(`## ${sectionIndex + 2}. ${next.field}`, start + heading.length);
  return candidate.slice(start, end === -1 ? candidate.length : end);
}

function withManualNotes(candidate: string): string {
  const marker = "<!-- docs-sync:generated:end section=01 -->";
  const index = candidate.indexOf(marker);
  assert.notEqual(index, -1);
  const insertAt = index + marker.length;
  return `${candidate.slice(0, insertAt)}\n\n### Human-maintained notes\nKeep this approved note byte-for-byte.\n${candidate.slice(insertAt)}`;
}

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

test("runs first generation through validation and repeats deterministically without writes", async () => {
  const sourceFiles = {
    "README.md": "# Pipeline app\nA synthetic application fixture.\n",
    "package.json": nodeProject({ zod: "^3.0.0" }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { zod: "^3.0.0" } },
        "node_modules/zod": { version: "3.4.1" },
      },
    }),
    "src/index.ts": "import { z } from 'zod';\nexport const schema = z.string();\n",
  };
  const first = await runSnapshot(sourceFiles);
  const result = requireSuccess(first.result);

  assert.equal(result.context.stage, "PROPOSED");
  assert.equal(result.context.defaultBranch, DEFAULT_BRANCH);
  assert.equal(result.context.snapshotCommitSha, FIRST_COMMIT);
  assert.equal(result.filtered.existingProfile.status, "absent");
  assert.ok(result.analysis.observations.some((item) => item.category === "package_name" && item.value === "pipeline-app"));
  const dependency = result.evidenceCatalog.evidence.find((item) => item.profileField === "Dependencies" && item.fact.name === "zod");
  assert.ok(dependency);
  assert.equal(dependency.fact.value, "^3.0.0");
  assert.ok(result.evidenceCatalog.evidence.some((item) => item.profileField === "Dependencies" && item.fact.value === "3.4.1"));
  assert.deepEqual([...result.composition.candidate.matchAll(/^## \d+\. .+$/gm)].map((match) => match[0]),
    PROFILE_SECTIONS.map((section, index) => `## ${index + 1}. ${section.field}`));
  assert.match(profileSection(result.composition.candidate, "05"), new RegExp(dependency.evidenceId));
  assert.equal(result.reconciliation.status, "FIRST_GENERATION");
  assert.equal(result.validation.status, "PASS");
  assert.equal(result.gate.status, "PASS");
  assert.equal(result.proposalAuthorization.status, "AUTHORIZED");
  assert.equal(result.proposal.status, "CREATED");
  assert.equal(result.reconciliation.candidate, result.composition.candidate);
  assert.equal(first.fixture.calls.metadata, 4);
  assert.deepEqual(first.fixture.calls.branches, Array(4).fill(DEFAULT_BRANCH));
  assert.deepEqual(first.fixture.calls.blobs, Object.keys(sourceFiles).sort(compareText));
  assert.deepEqual([...first.fixture.files], [...first.fixture.originalFiles]);
  assert.equal(first.fixture.files.has(TECHNICAL_PROFILE_PATH), false);
  assert.deepEqual(first.fixture.scanner.scannedPaths[0], Object.keys(sourceFiles).sort(compareText));

  const second = requireSuccess((await runSnapshot(sourceFiles)).result);
  assert.equal(second.composition.candidate, result.composition.candidate);
  assert.deepEqual(second.evidenceCatalog.evidence, result.evidenceCatalog.evidence);
  assert.equal(second.composition.candidateSha256, result.composition.candidateSha256);
});

test("returns NO_CHANGES for an identical generated profile and preserves manual notes", async () => {
  const sourceFiles = { "package.json": nodeProject({ zod: "^3.0.0" }) };
  const generated = requireSuccess((await runSnapshot(sourceFiles)).result).composition.candidate;
  const existingProfile = withManualNotes(generated);
  const run = await runSnapshot({ ...sourceFiles, [TECHNICAL_PROFILE_PATH]: existingProfile });
  const result = requireSuccess(run.result);

  assert.equal(result.reconciliation.status, "NO_CHANGES");
  assert.equal(result.proposal.status, "NO_CHANGES");
  assert.equal(result.reconciliation.candidate, existingProfile);
  assert.equal(result.reconciliation.candidateSha256?.length, 64);
  assert.deepEqual(result.reconciliation.additions, []);
  assert.deepEqual(result.reconciliation.modifications, []);
  assert.deepEqual(result.reconciliation.removals, []);
  assert.equal(result.reconciliation.preservedManualContent, true);
  assert.ok(result.reconciliation.candidate?.includes("### Human-maintained notes\nKeep this approved note byte-for-byte.\n"));
  assert.equal(result.validation.status, "PASS");
  assert.equal(result.gate.status, "PASS");
  assert.equal(run.fixture.files.get(TECHNICAL_PROFILE_PATH), existingProfile);
  assert.deepEqual([...run.fixture.files], [...run.fixture.originalFiles]);
});

test("adds newly supported evidence to the corresponding generated profile field", async () => {
  const previousFiles = { "package.json": nodeProject() };
  const previousProfile = requireSuccess((await runSnapshot(previousFiles, FIRST_COMMIT)).result).composition.candidate;
  const currentFiles = { "package.json": nodeProject({ zod: "^3.0.0" }) };
  const run = await runSnapshot({ ...currentFiles, [TECHNICAL_PROFILE_PATH]: previousProfile }, SECOND_COMMIT);
  const result = requireSuccess(run.result);
  const newDependency = result.evidenceCatalog.evidence.find((item) => item.profileField === "Dependencies" && item.fact.name === "zod");

  assert.ok(newDependency);
  assert.equal(newDependency.fact.value, "^3.0.0");
  assert.equal(result.reconciliation.status, "CHANGED");
  const addition = result.reconciliation.additions.find((change) => change.sectionId === "05" && change.after?.includes("zod"));
  assert.ok(addition);
  assert.ok(addition.evidenceIds.includes(newDependency.evidenceId));
  assert.match(profileSection(result.reconciliation.candidate ?? "", "05"), new RegExp(newDependency.evidenceId));
  assert.equal(result.validation.status, "PASS");
  assert.equal(result.gate.status, "PASS");
  assert.deepEqual([...run.fixture.files], [...run.fixture.originalFiles]);
});

test("updates changed evidence and removes obsolete generated evidence without retaining old claims", async () => {
  const originalFiles = { "package.json": nodeProject({ leftpad: "^1.0.0", obsolete: "~2.0.0" }) };
  const originalResult = requireSuccess((await runSnapshot(originalFiles, FIRST_COMMIT)).result);
  const originalProfile = originalResult.composition.candidate;
  const currentFiles = { "package.json": nodeProject({ leftpad: "^2.0.0" }) };
  const run = await runSnapshot({ ...currentFiles, [TECHNICAL_PROFILE_PATH]: originalProfile }, SECOND_COMMIT);
  const result = requireSuccess(run.result);
  const dependencySection = profileSection(result.reconciliation.candidate ?? "", "05");
  const changed = result.reconciliation.modifications.find((change) =>
    change.sectionId === "05" && change.before?.includes("^1.0.0") && change.after?.includes("^2.0.0"));

  assert.equal(result.reconciliation.status, "CHANGED");
  assert.ok(changed);
  const traceableIds = new Set([
    ...originalResult.evidenceCatalog.evidence.map((item) => item.evidenceId),
    ...result.evidenceCatalog.evidence.map((item) => item.evidenceId),
  ]);
  assert.ok(changed.evidenceIds.every((id) => traceableIds.has(id)));
  assert.ok(result.reconciliation.removals.some((change) => change.sectionId === "05" && change.before?.includes("obsolete")));
  assert.match(dependencySection, /leftpad/);
  assert.match(dependencySection, /\^2\.0\.0/);
  assert.doesNotMatch(dependencySection, /\^1\.0\.0|obsolete|~2\.0\.0/);
  assert.equal(result.validation.status, "PASS");
  assert.equal(result.gate.status, "PASS");
  assert.deepEqual([...run.fixture.files], [...run.fixture.originalFiles]);
});

test("surfaces conflicting manifest and repository-name evidence with traceable IDs", async () => {
  const run = await runSnapshot({ "package.json": nodeProject() });
  const result = requireSuccess(run.result);
  const nameRow = profileSection(result.reconciliation.candidate ?? "", "01");
  const competingEvidence = result.evidenceCatalog.evidence.filter((item) => item.profileField === "Application Name");

  assert.equal(result.validation.status, "PASS");
  assert.equal(result.gate.status, "PASS");
  assert.match(nameRow, /\| Application Name \| Conflicting evidence; see Evidence \/ Verification Status \| Conflict \|/);
  assert.ok(competingEvidence.length >= 2);
  for (const item of competingEvidence) {
    assert.match(nameRow, new RegExp(item.evidenceId));
    assert.match(profileSection(result.reconciliation.candidate ?? "", "16"), new RegExp(item.evidenceId));
  }
});

test("preserves approved profile bytes and emits no candidate when scanning or reconciliation fails", async (t) => {
  const sourceFiles = { "package.json": nodeProject() };
  const validProfile = requireSuccess((await runSnapshot(sourceFiles)).result).composition.candidate;

  await t.test("candidate scanner failure", async () => {
    const scanner = new SyntheticScanner();
    scanner.failOnCall = 2;
    const originalProfile = withManualNotes(validProfile);
    const run = await runSnapshot({ ...sourceFiles, [TECHNICAL_PROFILE_PATH]: originalProfile }, SECOND_COMMIT, scanner);

    assert.equal(run.result.ok, false);
    if (run.result.ok) return;
    assert.equal(run.result.error.code, "GATE_BLOCKED");
    assert.equal(run.result.validation?.status, "BLOCKED");
    assert.equal("candidate" in run.result, false);
    assert.equal(run.fixture.files.get(TECHNICAL_PROFILE_PATH), originalProfile);
    assert.deepEqual([...run.fixture.files], [...run.fixture.originalFiles]);
  });

  await t.test("malformed existing profile", async () => {
    const originalProfile = validProfile.replace("schema=1", "schema=99");
    const run = await runSnapshot({ ...sourceFiles, [TECHNICAL_PROFILE_PATH]: originalProfile }, SECOND_COMMIT);

    assert.equal(run.result.ok, false);
    if (run.result.ok) return;
    assert.equal(run.result.error.code, "RECONCILIATION_BLOCKED");
    assert.equal(run.result.reconciliation?.candidate, undefined);
    assert.equal(run.result.reconciliation?.existingProfilePreserved, true);
    assert.equal(run.fixture.files.get(TECHNICAL_PROFILE_PATH), originalProfile);
    assert.deepEqual([...run.fixture.files], [...run.fixture.originalFiles]);
  });
});