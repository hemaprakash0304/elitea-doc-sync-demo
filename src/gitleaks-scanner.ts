import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { SecretScanInputFile, SecretScanOutcome, SecretScanner } from "./filter.js";

const GITLEAKS_VERSION = "8.30.1";
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const SAFE_RULE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const require = createRequire(import.meta.url);

interface RawFinding {
  File?: unknown;
  RuleID?: unknown;
  StartLine?: unknown;
}

export class GitleaksSecretScanner implements SecretScanner {
  readonly id = "gitleaks" as const;
  readonly executionBoundary = "local" as const;
  readonly version = `gitleaks/${GITLEAKS_VERSION}`;

  async scan(files: readonly SecretScanInputFile[], signal?: AbortSignal): Promise<SecretScanOutcome> {
    if (files.length === 0) {
      return { status: "complete", scannedFileCount: 0, findings: [] };
    }

    const inputs = validateInputs(files);
    if (inputs === undefined) {
      return failed("INVALID_SCAN_RESULT");
    }

    let binaryPath: string;
    try {
      const packageDirectory = dirname(require.resolve("@b12k/gitleaks/package.json"));
      binaryPath = join(packageDirectory, "dist", process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
      await access(binaryPath);
    } catch {
      return failed("SCANNER_UNAVAILABLE");
    }

    const configPath = resolve(process.cwd(), ".gitleaks.toml");
    try {
      await access(configPath);
    } catch {
      return failed("SCANNER_UNAVAILABLE");
    }

    let temporaryRoot: string | undefined;
    try {
      temporaryRoot = await mkdtemp(join(tmpdir(), "docs-sync-gitleaks-"));
      for (const [path, content] of inputs) {
        const destination = join(temporaryRoot, ...path.split("/"));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
      }

      const result = await runGitleaks(binaryPath, configPath, temporaryRoot, signal);
      const rawFindings = parseReport(result.stdout);
      if (rawFindings === undefined || (result.exitCode !== 0 && !(result.exitCode === 1 && rawFindings.length > 0))) {
        return failed("SCANNER_FAILED");
      }

      const findings = rawFindings.map((finding) => sanitizeFinding(finding, temporaryRoot as string, inputs));
      if (findings.some((finding) => finding === undefined)) {
        return failed("INVALID_SCAN_RESULT");
      }
      return {
        status: "complete",
        scannedFileCount: files.length,
        findings: findings.filter((finding): finding is NonNullable<typeof finding> => finding !== undefined),
      };
    } catch {
      return failed(signal?.aborted === true ? "SCANNER_TIMEOUT" : "SCANNER_FAILED");
    } finally {
      if (temporaryRoot !== undefined) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
}

function validateInputs(files: readonly SecretScanInputFile[]): Map<string, string> | undefined {
  const inputs = new Map<string, string>();
  for (const file of files) {
    if (typeof file.path !== "string" || typeof file.content !== "string") return undefined;
    const normalizedPath = file.path.replace(/\\/g, "/");
    const segments = normalizedPath.split("/");
    if (
      normalizedPath.length === 0 || isAbsolute(normalizedPath) ||
      /^[A-Za-z]:/.test(normalizedPath) || /[\u0000-\u001f\u007f]/.test(normalizedPath) ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      inputs.has(normalizedPath)
    ) {
      return undefined;
    }
    inputs.set(normalizedPath, file.content);
  }
  return inputs;
}

function runGitleaks(
  binaryPath: string,
  configPath: string,
  targetPath: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted === true) {
      rejectPromise(new Error("scan aborted"));
      return;
    }

    const child = spawn(binaryPath, [
      "dir",
      "--config", configPath,
      "--redact=100",
      "--report-format=json",
      "--report-path", "-",
      "--no-banner",
      "--no-color",
      "--max-archive-depth=0",
      "--max-decode-depth=0",
      targetPath,
    ], {
      cwd: targetPath,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      env: process.platform === "win32"
        ? { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
        : { PATH: process.env.PATH ?? "" },
    });
    const chunks: Buffer[] = [];
    let reportBytes = 0;
    let reportOverflow = false;
    let settled = false;
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      reportBytes += chunk.length;
      if (reportBytes > MAX_REPORT_BYTES) {
        reportOverflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      rejectPromise(new Error("scanner process failed"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted === true || reportOverflow || code === null) {
        rejectPromise(new Error("scanner process failed"));
        return;
      }
      resolvePromise({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function parseReport(stdout: string): RawFinding[] | undefined {
  if (stdout.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(stdout);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "object" && item !== null)
      ? parsed as RawFinding[]
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeFinding(
  finding: RawFinding,
  temporaryRoot: string,
  inputs: ReadonlyMap<string, string>,
): { path: string; ruleId?: string; severity: "unknown"; line?: number } | undefined {
  if (typeof finding.File !== "string" || typeof finding.RuleID !== "string" || !SAFE_RULE_ID.test(finding.RuleID)) {
    return undefined;
  }
  const relativePath = isAbsolute(finding.File)
    ? relative(temporaryRoot, finding.File)
    : finding.File;
  const normalizedPath = relativePath.split(sep).join("/");
  if (
    normalizedPath.length === 0 || normalizedPath.startsWith("../") || normalizedPath === ".." ||
    !inputs.has(normalizedPath)
  ) {
    return undefined;
  }
  return {
    path: normalizedPath,
    ruleId: finding.RuleID,
    severity: "unknown",
    ...(Number.isSafeInteger(finding.StartLine) && (finding.StartLine as number) > 0 ? { line: finding.StartLine as number } : {}),
  };
}

function failed(errorCode: "SCANNER_UNAVAILABLE" | "SCANNER_FAILED" | "SCANNER_TIMEOUT" | "INVALID_SCAN_RESULT"): SecretScanOutcome {
  return { status: "failed", scannedFileCount: 0, findings: [], errorCode };
}