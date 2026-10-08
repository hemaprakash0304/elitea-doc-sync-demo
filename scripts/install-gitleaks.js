import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const expectedVersion = "8.30.1";

async function main() {
  const packageDirectory = dirname(require.resolve("@b12k/gitleaks/package.json"));
  const binaryPath = join(packageDirectory, "dist", process.platform === "win32" ? "gitleaks.exe" : "gitleaks");
  try {
    await access(binaryPath);
  } catch {
    const installerPath = join(packageDirectory, "dist", "postinstall.js");
    await execFileAsync(process.execPath, [installerPath], { cwd: packageDirectory });
  }

  const { stdout } = await execFileAsync(binaryPath, ["version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  if (stdout.trim() !== expectedVersion) {
    throw new Error("Pinned Gitleaks version verification failed.");
  }
}

main().catch(() => {
  process.stderr.write("Pinned Gitleaks installation or version verification failed. Secret scanning will remain unavailable.\n");
  process.exitCode = 1;
});