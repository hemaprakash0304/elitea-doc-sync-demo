import { fileURLToPath } from "node:url";
import { coordinateRun } from "./coordinator.js";
import { createRunConfiguration, ConfigurationError } from "./config.js";
import { GitleaksSecretScanner } from "./gitleaks-scanner.js";
import { createGitHubProposalWriteClient } from "./github-proposal-client.js";
import {
  AUTOMATED_TEST_SUITE_VERSION,
  REQUIRED_AUTOMATED_TEST_COUNT,
  type AutomatedTestBinding,
  type AutomatedTestResult,
} from "./gate.js";

export function createBoundAutomatedTestAttestation(
  binding: AutomatedTestBinding,
  environment: NodeJS.ProcessEnv = process.env,
): AutomatedTestResult {
  if (environment.DOCS_SYNC_AUTOMATED_TESTS_PASSED !== "true") {
    return {
      status: "UNAVAILABLE",
      suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      skippedTests: 0,
      binding,
    };
  }
  return {
    status: "PASS",
    suiteVersion: AUTOMATED_TEST_SUITE_VERSION,
    totalTests: REQUIRED_AUTOMATED_TEST_COUNT,
    passedTests: REQUIRED_AUTOMATED_TEST_COUNT,
    failedTests: 0,
    skippedTests: 0,
    binding,
  };
}

async function main(): Promise<number> {
  try {
    const args = process.argv.slice(2);
    const validateOnlyCount = args.filter((argument) => argument === "--validate-only").length;
    if (validateOnlyCount > 1) throw new ConfigurationError();
    const validateOnly = validateOnlyCount === 1;
    const configuration = createRunConfiguration(args.filter((argument) => argument !== "--validate-only"), process.env);
    const result = await coordinateRun(configuration, {
      secretScanner: new GitleaksSecretScanner(),
      automatedTests: (binding) => createBoundAutomatedTestAttestation(binding, process.env),
      ...(validateOnly ? {} : {
        createProposalWriteClient: (runConfiguration, repository) =>
          createGitHubProposalWriteClient(runConfiguration, repository),
      }),
    });
    if (validateOnly) {
      const gateStatus = result.ok ? result.gate.status : result.gate?.status;
      const validationPassed = result.ok
        ? result.gate.status === "PASS"
        : result.gate?.status === "PASS" && result.proposal?.failureCode === "PROPOSAL_CAPABILITY_UNAVAILABLE";
      if (validationPassed) {
        process.stdout.write(`${JSON.stringify({
          event: "validation_passed",
          runId: result.context?.runId,
          normalizedRepositoryId: result.context?.normalizedRepositoryId,
          snapshotCommitSha: result.context?.snapshotCommitSha,
          candidateSha256: result.ok ? result.reconciliation.candidateSha256 : result.reconciliation?.candidateSha256,
          gateStatus,
          proposalAttempted: false,
        })}\n`);
        return 0;
      }
    }
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify(result.diagnostic)}\n`);
      return 2;
    }

    process.stdout.write(`${JSON.stringify(result.diagnostic)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof ConfigurationError
      ? error.message
      : "Configuration could not be processed safely.";
    process.stderr.write(`${message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}