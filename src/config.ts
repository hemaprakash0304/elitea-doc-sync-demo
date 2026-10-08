export type ExecutionContext = "local" | "actions";

export interface RunConfiguration {
  targetRepository: string;
  normalizedRepositoryId: string;
  executionContext: ExecutionContext;
  runId?: string;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const SAFE_CONFIGURATION_ERROR =
  "Invalid CLI configuration. Provide exactly one --repository OWNER/REPO value. Branch overrides and unsupported options are not accepted.";

export class ConfigurationError extends Error {
  constructor() {
    super(SAFE_CONFIGURATION_ERROR);
    this.name = "ConfigurationError";
  }
}

export function parseCliArguments(
  args: string[],
  executionContext: ExecutionContext,
  runId?: string,
): RunConfiguration {
  let targetRepository: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === undefined) {
      throw new ConfigurationError();
    }

    if (argument === "--repository") {
      if (targetRepository !== undefined) {
        throw new ConfigurationError();
      }

      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ConfigurationError();
      }

      targetRepository = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--repository=")) {
      if (targetRepository !== undefined) {
        throw new ConfigurationError();
      }

      targetRepository = argument.slice("--repository=".length);
      continue;
    }

    throw new ConfigurationError();
  }

  if (targetRepository === undefined || !isRepositoryTarget(targetRepository)) {
    throw new ConfigurationError();
  }

  const normalizedRepositoryId = normalizeRepositoryIdentifier(targetRepository);
  return runId === undefined
    ? { targetRepository, normalizedRepositoryId, executionContext }
    : { targetRepository, normalizedRepositoryId, executionContext, runId };
}

export function createRunConfiguration(
  args: string[],
  environment: NodeJS.ProcessEnv,
): RunConfiguration {
  const executionContext: ExecutionContext = environment.GITHUB_ACTIONS === "true" ? "actions" : "local";
  const runId = executionContext === "actions" ? environment.GITHUB_RUN_ID : undefined;

  return runId === undefined
    ? parseCliArguments(args, executionContext)
    : parseCliArguments(args, executionContext, runId);
}

export function normalizeRepositoryIdentifier(targetRepository: string): string {
  if (!isRepositoryTarget(targetRepository)) {
    throw new ConfigurationError();
  }

  return targetRepository.toLowerCase();
}

function isRepositoryTarget(value: string): boolean {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex < 0 || separatorIndex !== value.lastIndexOf("/")) {
    return false;
  }

  const owner = value.slice(0, separatorIndex);
  const repository = value.slice(separatorIndex + 1);
  return OWNER_PATTERN.test(owner) && REPOSITORY_PATTERN.test(repository);
}