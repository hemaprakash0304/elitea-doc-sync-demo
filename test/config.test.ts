import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ConfigurationError,
  createRunConfiguration,
  normalizeRepositoryIdentifier,
  parseCliArguments,
} from "../src/config.js";

test("accepts one valid OWNER/REPO target", () => {
  assert.deepEqual(parseCliArguments(["--repository", "octo-org/docs"], "local"), {
    targetRepository: "octo-org/docs",
    normalizedRepositoryId: "octo-org/docs",
    executionContext: "local",
  });
});

test("accepts mixed-case names and normalizes their identifier", () => {
  const configuration = parseCliArguments(["--repository", "Octo-Org/Docs.API_v2"], "local");

  assert.equal(configuration.targetRepository, "Octo-Org/Docs.API_v2");
  assert.equal(configuration.normalizedRepositoryId, "octo-org/docs.api_v2");
});

test("accepts the equals form and captures Actions run context", () => {
  assert.deepEqual(
    createRunConfiguration(["--repository=octo-org/docs"], {
      GITHUB_ACTIONS: "true",
      GITHUB_RUN_ID: "12345",
    }),
    {
      targetRepository: "octo-org/docs",
      normalizedRepositoryId: "octo-org/docs",
      executionContext: "actions",
      runId: "12345",
    },
  );
});

test("rejects invalid repository formats", () => {
  const invalidTargets = [
    "",
    "owner",
    "/repo",
    "owner/",
    "owner/repo/extra",
    "https://github.com/owner/repo",
    "owner/repo@main",
    "owner/repo#main",
    "owner/repo:main",
    " owner/repo",
    "owner/repo ",
    "owner /repo",
    "owner/repo?",
    "bad--owner/repo",
    "owner/repo,other/repo",
  ];

  for (const target of invalidTargets) {
    assert.throws(() => parseCliArguments(["--repository", target], "local"), ConfigurationError);
  }
});

test("rejects a missing repository", () => {
  assert.throws(() => parseCliArguments([], "local"), ConfigurationError);
  assert.throws(() => parseCliArguments(["--repository"], "local"), ConfigurationError);
});

test("rejects multiple repository values", () => {
  assert.throws(
    () => parseCliArguments(["--repository", "one/repo", "--repository", "two/repo"], "local"),
    ConfigurationError,
  );
  assert.throws(() => parseCliArguments(["--repository", "one/repo", "two/repo"], "local"), ConfigurationError);
});

test("rejects branch overrides", () => {
  assert.throws(
    () => parseCliArguments(["--repository", "one/repo", "--branch", "main"], "local"),
    ConfigurationError,
  );
});

test("normalization is deterministic and rejects invalid values", () => {
  assert.equal(normalizeRepositoryIdentifier("Owner/Repo"), "owner/repo");
  assert.equal(
    normalizeRepositoryIdentifier("OWNER/REPO"),
    normalizeRepositoryIdentifier("owner/repo"),
  );
  assert.throws(() => normalizeRepositoryIdentifier("owner/repo@main"), ConfigurationError);
});

test("CLI errors do not echo untrusted values", () => {
  const untrustedValue = randomUUID();
  const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cliPath, "--repository", "invalid", "--token", untrustedValue],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid CLI configuration/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(untrustedValue));
});