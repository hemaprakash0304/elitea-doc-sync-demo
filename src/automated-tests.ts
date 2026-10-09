import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTOMATED_TEST_SUITE_VERSION,
  REQUIRED_AUTOMATED_TEST_COUNT,
  type AutomatedTestBinding,
  type AutomatedTestResult,
} from "./gate.js";

const MAX_TEST_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface TestExecutionEvidence {
  exitCode: number | null;
  output: string;
}

export type TestSuiteExecutor = (signal: AbortSignal) => Promise<TestExecutionEvidence>;

interface TestSummary {
  tests: number;
  passed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  todo: number;
}

export function createAutomatedTestRunner(
  execute: TestSuiteExecutor = executeProjectTestSuite,
): (binding: AutomatedTestBinding, signal: AbortSignal) => Promise<AutomatedTestResult> {
  return async (binding, signal) => {
    let evidence: TestExecutionEvidence;
    try {
      evidence = await execute(signal);
    } catch {
      return result("UNAVAILABLE", binding);
    }

    const summary = parseTestSummary(evidence.output);
    if (summary === undefined) return result("INDETERMINATE", binding);
    if (signal.aborted) return result("TIMEOUT", binding, summary);
    if (summary.cancelled > 0) return result("CANCELLED", binding, summary);
    if (summary.skipped > 0 || summary.todo > 0) return result("SKIPPED", binding, summary);
    if (evidence.exitCode !== 0 || summary.failed > 0) return result("FAIL", binding, summary);
    if (
      summary.tests !== REQUIRED_AUTOMATED_TEST_COUNT ||
      summary.passed !== summary.tests || summary.failed !== 0
    ) {
      return result("INDETERMINATE", binding, summary);
    }
    return result("PASS", binding, summary);
  };
}

function result(
  status: AutomatedTestResult["status"],
  binding: AutomatedTestBinding,
  summary?: TestSummary,
): AutomatedTestResult {
  return {
    status,
    suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
    totalTests: summary?.tests ?? 0,
    passedTests: summary?.passed ?? 0,
    failedTests: summary?.failed ?? 0,
    skippedTests: summary?.skipped ?? 0,
    binding,
  };
}

function parseTestSummary(output: string): TestSummary | undefined {
  const read = (label: string): number | undefined => {
    const match = new RegExp(`^# ${label} (\\d+)$`, "m").exec(output);
    return match === null ? undefined : Number(match[1]);
  };
  const tests = read("tests");
  const passed = read("pass");
  const failed = read("fail");
  const cancelled = read("cancelled");
  const skipped = read("skipped");
  const todo = read("todo");
  if ([tests, passed, failed, cancelled, skipped, todo].some((value) => value === undefined)) return undefined;
  return {
    tests: tests as number,
    passed: passed as number,
    failed: failed as number,
    cancelled: cancelled as number,
    skipped: skipped as number,
    todo: todo as number,
  };
}

async function executeProjectTestSuite(signal: AbortSignal): Promise<TestExecutionEvidence> {
  const buildDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(buildDirectory, "../..");
  const testRoot = resolve(projectRoot, "dist/test");
  const testFiles = await findTestFiles(testRoot);
  if (testFiles.length === 0) throw new Error("Built test suite is unavailable.");

  return new Promise((resolveEvidence, rejectEvidence) => {
    if (signal.aborted) {
      rejectEvidence(new Error("Test execution aborted."));
      return;
    }

    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
      cwd: projectRoot,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      signal,
      env: process.platform === "win32"
        ? { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
        : { PATH: process.env.PATH ?? "" },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let overflow = false;

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_TEST_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", () => rejectEvidence(new Error("Test process failed.")));
    child.once("close", (code) => {
      if (overflow || code === null) {
        rejectEvidence(new Error("Test result was incomplete."));
        return;
      }
      resolveEvidence({ exitCode: code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function findTestFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(path);
    }
  }
  return files;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
