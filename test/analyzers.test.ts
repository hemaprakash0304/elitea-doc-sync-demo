import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TECHNOLOGY_ANALYZERS, runTechnologyAnalyzers } from "../src/analyzers/index.js";
import { DocumentationAnalyzer } from "../src/analyzers/documentation.js";
import { DockerAnalyzer } from "../src/analyzers/docker.js";
import { GitHubActionsAnalyzer } from "../src/analyzers/github-actions.js";
import { JavaMavenAnalyzer } from "../src/analyzers/java-maven.js";
import { JavaScriptNodeAnalyzer } from "../src/analyzers/node.js";
import type { AnalyzerInput, TechnologyAnalyzer, TechnicalObservation } from "../src/analyzers/types.js";
import { filterRepositorySnapshot, type SecretScanInputFile, type SecretScanOutcome, type SecretScanner } from "../src/filter.js";
import type { CollectedFile, RepositoryCollectionResult } from "../src/collection.js";

const SNAPSHOT_SHA = "f".repeat(40);
const REPOSITORY = {
  repositoryId: 19,
  normalizedRepositoryId: "sample/analyzers",
  fullName: "sample/analyzers",
  isPrivate: false,
  defaultBranch: "trunk",
  readRetryCount: 0,
};

function file(path: string, content: string): AnalyzerInput["files"][number] {
  return {
    path,
    extension: extension(path),
    content,
    sourceCommitSha: SNAPSHOT_SHA,
    blobSha: "a".repeat(40),
  };
}

function input(files: AnalyzerInput["files"]): AnalyzerInput {
  return {
    repositoryId: REPOSITORY.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    files,
  };
}

function find(
  observations: readonly TechnicalObservation[],
  analyzer: TechnicalObservation["analyzer"],
  category: TechnicalObservation["category"],
  name?: string,
): TechnicalObservation | undefined {
  return observations.find((observation) => observation.analyzer === analyzer &&
    observation.category === category && (name === undefined || observation.name === name));
}

function extension(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot).toLowerCase();
}

function collectedFile(path: string, content: string): CollectedFile {
  return {
    path,
    extension: extension(path),
    mode: "100644",
    kind: "regular",
    size: Buffer.byteLength(content, "utf8"),
    blobSha: "b".repeat(40),
    sourceCommitSha: SNAPSHOT_SHA,
    contentStatus: "text",
    content,
  };
}

function repositoryCollection(files: CollectedFile[]): RepositoryCollectionResult {
  return {
    status: "complete",
    repository: REPOSITORY,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    snapshotTreeSha: "c".repeat(40),
    files,
    existingProfile: { profilePresent: false },
    totalTextBytes: files.reduce((sum, item) => sum + item.size, 0),
    issues: [],
    readRetryCount: 0,
  };
}

class CleanScanner implements SecretScanner {
  readonly id = "test_double" as const;
  readonly executionBoundary = "local" as const;
  readonly receivedPaths: string[][] = [];

  async scan(files: readonly SecretScanInputFile[]): Promise<SecretScanOutcome> {
    this.receivedPaths.push(files.map((item) => item.path));
    return { status: "complete", scannedFileCount: files.length, findings: [] };
  }
}

test("extracts Maven coordinates, Java level, dependencies, plugins, wrapper version, and Java references", () => {
  const pom = `
<project>
  <groupId>org.example</groupId>
  <artifactId>sample-service</artifactId>
  <version>1.2.0</version>
  <properties><maven.compiler.release>21</maven.compiler.release></properties>
  <dependencies>
    <dependency><groupId>org.example</groupId><artifactId>core-lib</artifactId><version>2.4</version><scope>runtime</scope></dependency>
      <dependency><groupId>org.example</groupId><artifactId>managed-lib</artifactId></dependency>
  </dependencies>
    <build><plugins>
      <plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>22</release></configuration></plugin>
      <plugin><artifactId>maven-surefire-plugin</artifactId><version>3.3.0</version></plugin>
    </plugins></build>
</project>`;
  const result = new JavaMavenAnalyzer().analyze(input([
    file("pom.xml", pom),
    file(".mvn/wrapper/maven-wrapper.properties", "distributionUrl=https://repo.example/apache-maven-3.9.8-bin.zip\n"),
    file("src/main/java/org/example/App.java", "package org.example;\nimport java.time.Instant;\nimport static org.example.Constants.VALUE;"),
  ]));

  assert.equal(find(result.observations, "java_maven", "project_coordinate", "artifactId")?.value, "sample-service");
  assert.equal(find(result.observations, "java_maven", "java_language_level", "maven.compiler.release")?.value, "21");
  const dependency = result.observations.find((observation) => observation.category === "dependency");
  assert.equal(dependency?.name, "org.example:core-lib");
  assert.equal(dependency?.attributes?.scope, "runtime");
  assert.equal(result.observations.find((observation) => observation.category === "dependency" && observation.name.endsWith(":managed-lib"))?.status, "Unable to Verify");
  assert.equal(find(result.observations, "java_maven", "java_language_level", "maven-compiler-plugin.release")?.value, "22");
  assert.equal(result.observations.find((observation) => observation.category === "build_plugin" && observation.name.endsWith(":maven-surefire-plugin"))?.name,
    "org.apache.maven.plugins:maven-surefire-plugin");
  assert.equal(find(result.observations, "java_maven", "maven_wrapper_version")?.value, "3.9.8");
  assert.equal(find(result.observations, "java_maven", "java_package")?.value, "org.example");
  assert.equal(result.observations.filter((observation) => observation.category === "java_import").length, 2);
  assert.equal(result.issues.length, 0);
});

test("does not send the existing technical profile to evidence analyzers", () => {
  const paths: string[] = [];
  const analyzer: TechnologyAnalyzer = {
    id: "documentation",
    analyze(input) {
      paths.push(...input.files.map((file) => file.path));
      return { observations: [], issues: [] };
    },
  };
  const result = runTechnologyAnalyzers({
    status: "ready",
    repositoryId: REPOSITORY.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    analysisFiles: [
      file("README.md", "sanitized documentation"),
      {
        path: "technical-profile.md",
        extension: ".md",
        content: "Existing human-approved profile",
        sourceCommitSha: SNAPSHOT_SHA,
        blobSha: "e".repeat(40),
      },
    ],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: {
      status: "complete",
      scanner: "test_double",
      expectedFileCount: 2,
      scannedFileCount: 2,
      coverageComplete: true,
    },
    existingProfile: { status: "safe_to_parse" },
  }, [analyzer]);

  assert.deepEqual(paths, ["README.md"]);
  assert.equal(result.snapshotCommitSha, SNAPSHOT_SHA);
});

test("extracts Node manifest declarations and npm lockfile direct resolved versions", () => {
  const packageJson = JSON.stringify({
    name: "sample-node",
    description: "Synthetic Node project",
    engines: { node: ">=20 <25" },
    dependencies: { zod: "^3.23.0", lodash: "~4.17.0" },
    devDependencies: { vitest: "^2.0.0" },
    scripts: { build: "tsc -p tsconfig.json", test: "vitest run" },
  });
  const packageLock = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { zod: "^3.23.0", lodash: "~4.17.0" }, devDependencies: { vitest: "^2.0.0" } },
      "node_modules/zod": { version: "3.23.8" },
      "node_modules/lodash": { version: "4.17.21" },
      "node_modules/vitest": { version: "2.1.3" },
      "node_modules/zod/node_modules/transitive-only": { version: "9.9.9" },
    },
  });
  const result = new JavaScriptNodeAnalyzer().analyze(input([
    file("package.json", packageJson),
    file("package-lock.json", packageLock),
    file("src/app.ts", "import { z } from 'zod';\nconst lodash = require('lodash');"),
  ]));

  assert.equal(find(result.observations, "javascript_node", "package_name")?.value, "sample-node");
  assert.equal(find(result.observations, "javascript_node", "package_description")?.value, "Synthetic Node project");
  assert.equal(find(result.observations, "javascript_node", "node_engine_constraint")?.value, ">=20 <25");
  const resolved = result.observations.filter((observation) => observation.source.kind === "lockfile");
  assert.deepEqual(resolved.map((observation) => [observation.name, observation.value]), [
    ["lodash", "4.17.21"], ["vitest", "2.1.3"], ["zod", "3.23.8"],
  ]);
  assert.equal(resolved.some((observation) => observation.name === "transitive-only"), false);
  assert.equal(find(result.observations, "javascript_node", "package_script", "test"), undefined);
  assert.ok(result.observations.some((observation) => observation.category === "test_command" && observation.value === "vitest run"));
  assert.ok(result.observations.some((observation) => observation.category === "test_tool" && observation.value === "Vitest"));
  assert.equal(result.observations.filter((observation) => observation.category === "node_module_reference").length, 2);
});

test("reads direct versions from yarn and pnpm lockfiles", () => {
  const yarnResult = new JavaScriptNodeAnalyzer().analyze(input([
    file("package.json", JSON.stringify({ name: "locks", dependencies: { "@scope/pkg": "^1.0.0", leftpad: "^2.0.0" } })),
    file("yarn.lock", `"@scope/pkg@^1.0.0":\n  version "1.2.3"\n  resolved "https://registry.example/pkg.tgz"\n\nleftpad@^2.0.0:\n  version "2.4.1"\n`),
  ]));
  assert.deepEqual(yarnResult.observations.filter((observation) => observation.source.kind === "lockfile")
    .map((observation) => [observation.name, observation.value]), [["@scope/pkg", "1.2.3"], ["leftpad", "2.4.1"]]);

  const pnpmResult = new JavaScriptNodeAnalyzer().analyze(input([
    file("package.json", JSON.stringify({ name: "locks", dependencies: { alpha: "^1.0.0" } })),
    file("pnpm-lock.yaml", `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      alpha:\n        specifier: ^1.0.0\n        version: 1.4.2\n`),
  ]));
  assert.equal(pnpmResult.observations.find((observation) => observation.source.kind === "lockfile")?.value, "1.4.2");
});

test("extracts Dockerfile and Compose declarations without environment values", () => {
  const syntheticValue = "SYNTHETIC_ONLY_SECRET=NEVER_EMIT_THIS_VALUE";
  const result = new DockerAnalyzer().analyze(input([
    file("Dockerfile", "FROM node:24 AS build\nRUN npm ci\nARG APP_MODE=production\nENV API_PORT=8080\nEXPOSE 8080/tcp\nFROM nginx:1.27 AS web"),
    file("compose.yaml", `services:\n  api:\n    image: node:24\n    ports: [\"3000:3000\"]\n    volumes: [\"./src:/app/src\"]\n    networks: [backend]\n    environment:\n      API_TOKEN: ${syntheticValue}\n      LOG_LEVEL: info\nnetworks:\n  backend:\n    driver: bridge\n`),
    file(".dockerignore", "node_modules\n.env\n"),
  ]));
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.observations.filter((observation) => observation.category === "docker_base_image")
    .map((observation) => observation.value), ["node:24", "nginx:1.27", "node:24"]);
  assert.ok(result.observations.some((observation) => observation.category === "docker_build_stage" && observation.name === "build"));
  assert.ok(result.observations.some((observation) => observation.category === "docker_build_command" && observation.value === "npm ci"));
  assert.ok(result.observations.some((observation) => observation.category === "docker_exposed_port" && observation.value === "8080/tcp"));
  assert.ok(result.observations.some((observation) => observation.category === "compose_service" && observation.name === "api"));
  assert.ok(result.observations.some((observation) => observation.category === "compose_volume"));
  assert.ok(result.observations.some((observation) => observation.category === "compose_network" && observation.name === "backend"));
  assert.ok(result.observations.some((observation) => observation.category === "compose_environment_variable" && observation.value === "API_TOKEN"));
  assert.ok(result.observations.some((observation) => observation.category === "docker_environment_variable" && observation.value === "API_PORT"));
  assert.doesNotMatch(serialized, /NEVER_EMIT_THIS_VALUE|info/);
  assert.equal(result.issues.length, 0);
});

test("extracts GitHub Actions declarations without inferring run outcomes or exposing values", () => {
  const syntheticValue = "SYNTHETIC_ONLY_TOKEN=NEVER_EMIT_ACTION_VALUE";
  const result = new GitHubActionsAnalyzer().analyze(input([
    file(".github/workflows/ci.yml", [
      "name: CI",
      "on:",
      "  push:",
      "  workflow_dispatch:",
      "permissions:",
      "  contents: read",
      "env:",
      `  CI_MODE: ${syntheticValue}`,
      "jobs:",
      "  verify:",
      "    name: Verify",
      "    permissions:",
      "      checks: write",
      "    env:",
      "      NODE_OPTIONS: --enable-source-maps",
      "    steps:",
      "      - name: Checkout",
      "        uses: actions/checkout@v4",
      "      - name: Unit tests",
      "        run: npm test",
      "        env:",
      "          TEST_ENV: local",
      "      - name: Deploy",
      "        run: 'echo ${{ secrets.DEPLOY_TOKEN }}'",
    ].join("\n")),
  ]));
  const serialized = JSON.stringify(result);

  assert.equal(find(result.observations, "github_actions", "workflow_name")?.value, "CI");
  assert.ok(result.observations.some((observation) => observation.category === "workflow_trigger" && observation.value === "push"));
  assert.ok(result.observations.some((observation) => observation.category === "workflow_trigger" && observation.value === "workflow_dispatch"));
  assert.ok(result.observations.some((observation) => observation.category === "workflow_job" && observation.name === "Verify"));
  assert.ok(result.observations.some((observation) => observation.category === "github_action" && observation.value === "actions/checkout@v4"));
  assert.ok(result.observations.some((observation) => observation.category === "workflow_permission" && observation.name === "checks"));
  assert.ok(result.observations.some((observation) => observation.category === "workflow_step" && observation.value === "npm test"));
  assert.ok(result.observations.some((observation) => observation.category === "workflow_environment_variable" && observation.value === "TEST_ENV"));
  assert.doesNotMatch(serialized, /NEVER_EMIT_ACTION_VALUE|DEPLOY_TOKEN|echo/);
  assert.equal(result.issues.length, 0);
});

test("keeps documentation claims lower-authority and flags explicit manifest disagreement", () => {
  const result = new DocumentationAnalyzer().analyze(input([
    file("package.json", JSON.stringify({ name: "manifest-name" })),
    file("README.md", "Project name: readme-name\nBuilt with Java, Docker and Python.\nRun `npm test` before review."),
    file("config/application.properties", "maven.compiler.release=21\nspring.datasource.password=SYNTHETIC_ONLY_SECRET=SAFE_TEST_ONLY"),
  ]));
  const nameClaim = find(result.observations, "documentation", "package_name");

  assert.equal(nameClaim?.status, "Conflict");
  assert.equal(nameClaim?.confidence, "Low");
  assert.equal(nameClaim?.verificationBasis, "documentation_claim");
  assert.ok(result.observations.some((observation) => observation.category === "unsupported_technology" &&
    observation.value === "Python" && observation.status === "Unable to Verify"));
  assert.ok(result.observations.some((observation) => observation.category === "configuration_reference" && observation.name === "maven.compiler.release"));
  assert.ok(result.observations.some((observation) => observation.category === "documented_command" && observation.value === "npm test"));
  assert.doesNotMatch(JSON.stringify(result), /SAFE_TEST_ONLY|spring.datasource.password/);
});

test("reports missing files as no observations and malformed manifests as safe issues", () => {
  const empty = new JavaMavenAnalyzer().analyze(input([]));
  assert.deepEqual(empty, { observations: [], issues: [] });

  const result = runTechnologyAnalyzers({
    status: "ready",
    repositoryId: REPOSITORY.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    analysisFiles: [file("pom.xml", "<project><artifactId>broken")],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: { status: "complete", scanner: "test_double", expectedFileCount: 1, scannedFileCount: 1, coverageComplete: true },
    existingProfile: { status: "absent" },
  }, DEFAULT_TECHNOLOGY_ANALYZERS);
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.issues, [{ analyzer: "java_maven", code: "INVALID_XML", path: "pom.xml" }]);
  assert.doesNotMatch(JSON.stringify(result), /broken/);
});

test("converts analyzer exceptions to typed sanitized issues and keeps deterministic ordering", () => {
  const throwing: TechnologyAnalyzer = {
    id: "documentation",
    analyze() {
      throw new Error("SYNTHETIC_ONLY_TOKEN=DO_NOT_REPORT_123");
    },
  };
  const observations = new JavaScriptNodeAnalyzer().analyze(input([
    file("package.json", JSON.stringify({ dependencies: { zeta: "^1", alpha: "^2" } })),
  ])).observations;
  const result = runTechnologyAnalyzers({
    status: "ready",
    repositoryId: REPOSITORY.normalizedRepositoryId,
    defaultBranch: REPOSITORY.defaultBranch,
    snapshotCommitSha: SNAPSHOT_SHA,
    analysisFiles: [file("package.json", JSON.stringify({ dependencies: { zeta: "^1", alpha: "^2" } }))],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: { status: "complete", scanner: "test_double", expectedFileCount: 1, scannedFileCount: 1, coverageComplete: true },
    existingProfile: { status: "absent" },
  }, [throwing, new JavaScriptNodeAnalyzer()]);

  assert.deepEqual(observations.map((observation) => observation.name), ["alpha", "zeta"]);
  assert.deepEqual(result.issues, [{ analyzer: "documentation", code: "ANALYZER_FAILED", path: "" }]);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_REPORT_123/);
});

test("only sends IMP-06 included files into the analyzer runner", async () => {
  const collection = repositoryCollection([
    collectedFile("README.md", "Built with Docker."),
    collectedFile(".env", "SYNTHETIC_ONLY_SECRET=FILTERED_OUT_VALUE"),
  ]);
  const filtered = await filterRepositorySnapshot(collection, new CleanScanner());
  const result = runTechnologyAnalyzers(filtered, DEFAULT_TECHNOLOGY_ANALYZERS);

  assert.deepEqual(filtered.analysisFiles.map((item) => item.path), ["README.md"]);
  assert.ok(result.observations.some((observation) => observation.value === "Docker"));
  assert.doesNotMatch(JSON.stringify(result), /FILTERED_OUT_VALUE/);
});

test("produces byte-equivalent observations for repeated analysis of the same snapshot", () => {
  const snapshot = input([
    file("package.json", JSON.stringify({ name: "repeatable", dependencies: { zeta: "^1", alpha: "^2" } })),
    file("README.md", "Uses JavaScript and Docker."),
    file("Dockerfile", "FROM node:24 AS build\nEXPOSE 8080"),
  ]);
  const first = runTechnologyAnalyzers({
    status: "ready",
    repositoryId: snapshot.repositoryId,
    defaultBranch: snapshot.defaultBranch,
    snapshotCommitSha: snapshot.snapshotCommitSha,
    analysisFiles: [...snapshot.files],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: { status: "complete", scanner: "test_double", expectedFileCount: 3, scannedFileCount: 3, coverageComplete: true },
    existingProfile: { status: "absent" },
  }, DEFAULT_TECHNOLOGY_ANALYZERS);
  const second = runTechnologyAnalyzers({
    status: "ready",
    repositoryId: snapshot.repositoryId,
    defaultBranch: snapshot.defaultBranch,
    snapshotCommitSha: snapshot.snapshotCommitSha,
    analysisFiles: [...snapshot.files],
    exclusionRecords: [],
    fileRecords: [],
    securityFindings: [],
    scan: { status: "complete", scanner: "test_double", expectedFileCount: 3, scannedFileCount: 3, coverageComplete: true },
    existingProfile: { status: "absent" },
  }, DEFAULT_TECHNOLOGY_ANALYZERS);

  assert.deepEqual(first, second);
});
