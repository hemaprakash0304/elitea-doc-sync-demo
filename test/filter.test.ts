import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COLLECTION_FILES,
  MAX_COLLECTION_FILE_BYTES,
  MAX_COLLECTION_TEXT_BYTES,
  TECHNICAL_PROFILE_PATH,
  type CollectedFile,
  type RepositoryCollectionResult,
} from "../src/collection.js";
import {
  filterRepositorySnapshot,
  scanCandidateContent,
  UnavailableSecretScanner,
  type SecretScanInputFile,
  type SecretScanOutcome,
  type SecretScanner,
} from "../src/filter.js";
import { GitleaksSecretScanner } from "../src/gitleaks-scanner.js";

const SNAPSHOT_SHA = "a".repeat(40);
const REPOSITORY = {
  repositoryId: 17,
  normalizedRepositoryId: "sample/repo",
  fullName: "sample/repo",
  isPrivate: false,
  defaultBranch: "release/next",
  readRetryCount: 0,
};

test("runs the pinned local Gitleaks binary and returns only sanitized finding metadata", async () => {
  const scanner = new GitleaksSecretScanner();
  const syntheticValue = "SYNTHETIC_ONLY_TOKEN=FIXTURE_VALUE_NOT_A_CREDENTIAL_123";
  const result = await scanner.scan([
    { path: "src/clean.ts", content: "export const ready = true;" },
    { path: "src/synthetic.ts", content: `export const token = "${syntheticValue}";` },
  ]);

  assert.equal(scanner.version, "gitleaks/8.30.1");
  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(result.scannedFileCount, 2);
  assert.deepEqual(result.findings.map((finding) => finding.path), ["src/synthetic.ts"]);
  assert.doesNotMatch(JSON.stringify(result), /FIXTURE_VALUE_NOT_A_CREDENTIAL_123/);
});

class SyntheticSecretScanner implements SecretScanner {
  readonly id = "test_double" as const;
  readonly executionBoundary = "local" as const;
  readonly receivedPaths: string[][] = [];
  readonly receivedByteCounts: number[][] = [];
  outcome?: SecretScanOutcome;
  throwError?: Error;

  async scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    this.receivedPaths.push(files.map((file) => file.path));
    this.receivedByteCounts.push(files.map((file) => Buffer.byteLength(file.content, "utf8")));
    if (this.throwError !== undefined) {
      throw this.throwError;
    }
    if (this.outcome !== undefined) {
      return this.outcome;
    }

    const findings = files.flatMap((file) => {
      const match = /SYNTHETIC_ONLY_(?:TOKEN|SECRET)=([A-Za-z0-9_-]+)/g.exec(file.content);
      if (match === null) {
        return [];
      }
      return [{ path: file.path, ruleId: "synthetic_test_rule", severity: "high" as const, line: 1 }];
    });
    return { status: "complete", scannedFileCount: files.length, findings };
  }
}

function collectedFile(
  path: string,
  content = "safe fixture",
  overrides: Partial<CollectedFile> = {},
): CollectedFile {
  return {
    path,
    extension: extensionOf(path),
    mode: "100644",
    kind: "regular",
    size: Buffer.byteLength(content, "utf8"),
    blobSha: "b".repeat(40),
    sourceCommitSha: SNAPSHOT_SHA,
    contentStatus: "text",
    content,
    ...overrides,
  };
}

function collection(files: CollectedFile[], profileFile?: CollectedFile, issues: RepositoryCollectionResult["issues"] = []): RepositoryCollectionResult {
  return {
    status: issues.length === 0 ? "complete" : "partial",
    repository: REPOSITORY,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    snapshotTreeSha: "c".repeat(40),
    files,
    existingProfile: profileFile === undefined
      ? { profilePresent: false }
      : { profilePresent: true, file: profileFile },
    totalTextBytes: files.reduce((total, file) => total + (file.content === undefined ? 0 : Buffer.byteLength(file.content)), 0),
    issues,
    readRetryCount: 0,
  };
}

function extensionOf(path: string): string | null {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? null : basename.slice(dot).toLowerCase();
}

function record(result: Awaited<ReturnType<typeof filterRepositorySnapshot>>, path: string) {
  return result.fileRecords.find((entry) => entry.path === path);
}

test("keeps only allowlisted documentation, source, manifests, Docker, workflows, and config text", async () => {
  const paths = [
    "README.md",
    "docs/guide.rst",
    "docs/guide.adoc",
    "src/Main.java",
    "src/app.js",
    "src/app.jsx",
    "src/app.mjs",
    "src/app.cjs",
    "src/app.ts",
    "src/app.tsx",
    "pom.xml",
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Dockerfile",
    "Dockerfile.dev",
    "docker-compose.yml",
    ".github/workflows/ci.yaml",
    "config/app.json",
    "config/app.yaml",
    "config/app.toml",
    "config/app.xml",
    "config/app.properties",
    "config/app.ini",
    "config/app.cfg",
    "config/app.conf",
    "infra/main.tf",
    "infra/main.hcl",
    "db/schema.sql",
  ];
  const scanner = new SyntheticSecretScanner();

  const result = await filterRepositorySnapshot(collection(paths.map((path) => collectedFile(path))), scanner);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.analysisFiles.map((file) => file.path), [...paths].sort());
  assert.equal(scanner.receivedPaths[0]?.length, paths.length);
  assert.equal(result.existingProfile.status, "absent");
});

test("excludes sensitive paths, credentials, keys, generated output, logs, caches, and data dumps before scanning", async () => {
  const paths = [
    ".git/config",
    ".gitmodules",
    ".env",
    ".env.example",
    "config/local.env",
    ".envrc",
    ".npmrc",
    "credentials.json",
    "secrets.yaml",
    ".config/gcloud/application_default_credentials.json",
    ".ssh/id_ed25519",
    "keys/client.pem",
    "certs/client.crt",
    "settings.xml",
    ".docker/config.json",
    "node_modules/pkg/index.js",
    "vendor/lib/README.md",
    "target/classes/App.java",
    "dist/generated.json",
    "logs/app.log",
    "logs/app.log.1",
    ".cache/state.json",
    "tmp/build.json",
    "backup/data.csv",
    "exports/table.tsv",
    "data/events.jsonl",
    "database/dump.sql.gz",
    "src/bundle.min.js",
    "src/app.js.map",
    "documents/scan.pdf",
  ];
  const scanner = new SyntheticSecretScanner();

  const result = await filterRepositorySnapshot(collection(paths.map((path) => collectedFile(path))), scanner);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.analysisFiles, []);
  assert.deepEqual(scanner.receivedPaths[0], []);
  for (const path of paths) {
    assert.equal(record(result, path)?.disposition, "excluded", path);
  }
});

test("excludes binary content, symlinks, and submodules without scanning them", async () => {
  const files = [
    collectedFile("assets/logo.png", "", { contentStatus: "binary" }),
    collectedFile("linked/README.md", "", { kind: "symlink", contentStatus: "symlink_not_followed" }),
    collectedFile("modules/child/README.md", "", { kind: "submodule", contentStatus: "submodule_not_fetched" }),
  ];
  const scanner = new SyntheticSecretScanner();

  const result = await filterRepositorySnapshot(collection(files), scanner);

  assert.deepEqual(scanner.receivedPaths[0], []);
  assert.equal(record(result, "assets/logo.png")?.reason, "binary_file");
  assert.equal(record(result, "linked/README.md")?.reason, "symlink");
  assert.equal(record(result, "modules/child/README.md")?.reason, "submodule");
});

test("enforces the exact DEC-04 per-file, aggregate-text, and file-count limits", async (t) => {
  assert.equal(MAX_COLLECTION_FILE_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_COLLECTION_TEXT_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_COLLECTION_FILES, 5_000);

  await t.test("accepts exactly 2 MiB and omits the next byte", async () => {
    const exact = collectedFile("a.md", "x".repeat(MAX_COLLECTION_FILE_BYTES));
    const oversized = collectedFile("z.md", "x".repeat(MAX_COLLECTION_FILE_BYTES + 1));
    const scanner = new SyntheticSecretScanner();
    const result = await filterRepositorySnapshot(collection([exact, oversized]), scanner);

    assert.deepEqual(scanner.receivedPaths[0], ["a.md"]);
    assert.deepEqual(result.analysisFiles, []);
    assert.equal(record(result, "z.md")?.disposition, "omitted_due_to_limits");
    assert.equal(result.status, "blocked");
    assert.equal(result.scan.coverageComplete, false);
  });

  await t.test("omits content beyond exactly 20 MiB", async () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      collectedFile(`a/${index.toString().padStart(2, "0")}.md`, "x".repeat(1024 * 1024)),
    );
    files.push(collectedFile("z.md", "x"));
    const scanner = new SyntheticSecretScanner();
    const result = await filterRepositorySnapshot(collection(files), scanner);

    assert.equal(scanner.receivedByteCounts[0]?.reduce((sum, size) => sum + size, 0), MAX_COLLECTION_TEXT_BYTES);
    assert.equal(record(result, "z.md")?.disposition, "omitted_due_to_limits");
    assert.equal(result.status, "blocked");
  });

  await t.test("scans at most 5,000 paths and blocks on the omitted remainder", async () => {
    const files = Array.from({ length: MAX_COLLECTION_FILES + 1 }, (_, index) =>
      collectedFile(`src/${index.toString().padStart(5, "0")}.java`, "x"),
    );
    const scanner = new SyntheticSecretScanner();
    const result = await filterRepositorySnapshot(collection(files), scanner);

    assert.equal(scanner.receivedPaths[0]?.length, MAX_COLLECTION_FILES);
    assert.equal(record(result, `src/${MAX_COLLECTION_FILES.toString().padStart(5, "0")}.java`)?.reason, "file_count_limit");
    assert.equal(result.status, "blocked");
    assert.equal(result.scan.coverageComplete, false);
  });
});

test("excludes a whole secret-like source and never retains its synthetic value", async () => {
  const syntheticValue = "SYNTHETIC_ONLY_TOKEN=TEST_TOKEN_NOT_REAL_123";
  const clean = collectedFile("README.md", "safe documentation");
  const secret = collectedFile("src/config.ts", `export const key = \"${syntheticValue}\";`);
  const scanner = new SyntheticSecretScanner();

  const result = await filterRepositorySnapshot(collection([secret, clean]), scanner);
  const serialized = JSON.stringify(result);

  assert.equal(result.status, "partial");
  assert.deepEqual(result.analysisFiles.map((file) => file.path), ["README.md"]);
  assert.equal(record(result, "src/config.ts")?.disposition, "sensitive");
  assert.deepEqual(result.securityFindings, [{
    path: "src/config.ts",
    category: "secret_like_content",
    ruleId: "synthetic_test_rule",
    severity: "high",
    action: "file_excluded",
  }]);
  assert.doesNotMatch(serialized, /TEST_TOKEN_NOT_REAL_123/);
  assert.equal(result.scan.coverageComplete, true);
});

test("blocks an existing profile with a secret finding without changing its collected bytes", async () => {
  const value = "SYNTHETIC_ONLY_SECRET=NOT_A_CREDENTIAL_456";
  const profile = collectedFile(TECHNICAL_PROFILE_PATH, `# Existing\n${value}`);
  const scanner = new SyntheticSecretScanner();
  const original = profile.content;

  const result = await filterRepositorySnapshot(collection([profile], profile), scanner);

  assert.equal(result.status, "blocked");
  assert.equal(result.blockingReason, "EXISTING_PROFILE_SECRET");
  assert.deepEqual(result.existingProfile, { status: "blocking_sensitive_finding" });
  assert.deepEqual(result.analysisFiles, []);
  assert.equal(profile.content, original);
  assert.doesNotMatch(JSON.stringify(result), /NOT_A_CREDENTIAL_456/);
});

test("marks a clean existing profile safe to parse only when it matches the collected snapshot", async () => {
  const profile = collectedFile(TECHNICAL_PROFILE_PATH, "# Existing approved profile\nNo sensitive values.");
  const safeScanner = new SyntheticSecretScanner();
  const safeResult = await filterRepositorySnapshot(collection([profile], profile), safeScanner);

  assert.equal(safeResult.status, "ready");
  assert.deepEqual(safeResult.existingProfile, { status: "safe_to_parse" });
  assert.deepEqual(safeResult.analysisFiles.map((file) => file.path), [TECHNICAL_PROFILE_PATH]);

  const mismatchedResult = await filterRepositorySnapshot(collection([profile]), new SyntheticSecretScanner());
  assert.equal(mismatchedResult.status, "blocked");
  assert.equal(mismatchedResult.blockingReason, "EXISTING_PROFILE_UNAVAILABLE");
  assert.deepEqual(mismatchedResult.existingProfile, { status: "blocked_unavailable" });
  assert.deepEqual(mismatchedResult.analysisFiles, []);
});

test("unavailable, failed, throwing, and incomplete scanners all fail closed", async (t) => {
  const input = collection([collectedFile("README.md")]);

  await t.test("unavailable default scanner blocks", async () => {
    const result = await filterRepositorySnapshot(input, new UnavailableSecretScanner());
    assert.equal(result.status, "blocked");
    assert.equal(result.blockingReason, "SCANNER_UNAVAILABLE");
    assert.deepEqual(result.analysisFiles, []);
  });

  await t.test("scanner exception content is discarded", async () => {
    const scanner = new SyntheticSecretScanner();
    scanner.throwError = new Error("SYNTHETIC_ONLY_TOKEN=DO_NOT_ECHO_789");
    const result = await filterRepositorySnapshot(input, scanner);
    assert.equal(result.blockingReason, "SCANNER_FAILED");
    assert.deepEqual(result.analysisFiles, []);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO_789/);
  });

  await t.test("explicit incomplete scan blocks", async () => {
    const scanner = new SyntheticSecretScanner();
    scanner.outcome = { status: "incomplete", scannedFileCount: 0, findings: [], errorCode: "SCAN_INCOMPLETE" };
    const result = await filterRepositorySnapshot(input, scanner);
    assert.equal(result.blockingReason, "SCAN_INCOMPLETE");
    assert.deepEqual(result.analysisFiles, []);
  });

  await t.test("short scan count blocks even when scanner reports complete", async () => {
    const scanner = new SyntheticSecretScanner();
    scanner.outcome = { status: "complete", scannedFileCount: 0, findings: [] };
    const result = await filterRepositorySnapshot(input, scanner);
    assert.equal(result.blockingReason, "SCAN_INCOMPLETE");
    assert.deepEqual(result.analysisFiles, []);
  });

  await t.test("scanner timeout blocks and returns only a typed timeout code", async () => {
    const scanner: SecretScanner = {
      id: "test_double",
      executionBoundary: "local",
      scan: async (_files, signal) => new Promise<SecretScanOutcome>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("SYNTHETIC_ONLY_TOKEN=TIMEOUT_VALUE")), { once: true });
      }),
    };
    const result = await filterRepositorySnapshot(input, scanner, { scannerTimeoutMs: 5 });
    assert.equal(result.status, "blocked");
    assert.equal(result.blockingReason, "SCANNER_TIMEOUT");
    assert.deepEqual(result.analysisFiles, []);
    assert.doesNotMatch(JSON.stringify(result), /TIMEOUT_VALUE/);
  });
});

test("orders analysis inputs and findings deterministically and preserves the snapshot SHA", async () => {
  const first = collectedFile("z.java", "SYNTHETIC_ONLY_TOKEN=SAFE_FIXTURE_1");
  const second = collectedFile("a.ts", "SYNTHETIC_ONLY_SECRET=SAFE_FIXTURE_2");
  const scanner = new SyntheticSecretScanner();

  const result = await filterRepositorySnapshot(collection([first, second]), scanner);

  assert.equal(result.snapshotCommitSha, SNAPSHOT_SHA);
  assert.deepEqual(result.securityFindings.map((finding) => finding.path), ["a.ts", "z.java"]);
  assert.deepEqual(result.fileRecords.map((entry) => entry.path), ["a.ts", "z.java"]);
  assert.deepEqual(result.analysisFiles, []);
  assert.equal(result.status, "partial");
});

test("treats collected repository code as inert text and performs no network access", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response();
  };
  const source = collectedFile("src/no-execution.ts", "process.exit(99); throw new Error('never run');");
  const scanner = new SyntheticSecretScanner();

  try {
    const result = await filterRepositorySnapshot(collection([source]), scanner);
    assert.equal(result.status, "ready");
    assert.equal(result.analysisFiles[0]?.content, source.content);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candidate scans block secret findings and scanner failures", async () => {
  const scanner = new SyntheticSecretScanner();
  const secretCandidate = await scanCandidateContent(
    "# Candidate\nSYNTHETIC_ONLY_TOKEN=CANDIDATE_VALUE_NOT_REAL",
    scanner,
  );
  assert.equal(secretCandidate.status, "blocked");
  assert.equal(secretCandidate.blockingReason, "CANDIDATE_SECRET_FOUND");
  assert.doesNotMatch(JSON.stringify(secretCandidate), /CANDIDATE_VALUE_NOT_REAL/);

  const unavailable = await scanCandidateContent("# Candidate", new UnavailableSecretScanner());
  assert.equal(unavailable.status, "blocked");
  assert.equal(unavailable.blockingReason, "SCANNER_UNAVAILABLE");
});

test("marks unreadable eligible files and collected count omissions as incomplete coverage", async () => {
  const unreadable = collectedFile("README.md", "", { contentStatus: "unreadable", size: 0 });
  delete unreadable.content;
  const scanner = new SyntheticSecretScanner();
  const result = await filterRepositorySnapshot(collection([unreadable]), scanner);
  assert.equal(result.status, "blocked");
  assert.equal(record(result, "README.md")?.disposition, "unreadable");
  assert.equal(result.scan.coverageComplete, false);

  const countLimited = await filterRepositorySnapshot(
    collection([], undefined, [{ code: "FILE_COUNT_LIMIT", count: 1 }]),
    new SyntheticSecretScanner(),
  );
  assert.equal(countLimited.status, "blocked");
  assert.equal(countLimited.blockingReason, "COLLECTION_INCOMPLETE");
  assert.equal(countLimited.scan.coverageComplete, false);
});
