export interface OperationalLimits {
  overallRunTimeoutMs: number;
  scannerTimeoutMs: number;
  proposalOperationTimeoutMs: number;
  maxProposalRunsPerTarget: 1;
}

export type OperationalLimitOverrides = Partial<Omit<OperationalLimits, "maxProposalRunsPerTarget">>;

export const DEFAULT_OPERATIONAL_LIMITS: OperationalLimits = Object.freeze({
  overallRunTimeoutMs: 10 * 60 * 1000,
  scannerTimeoutMs: 30 * 1000,
  proposalOperationTimeoutMs: 30 * 1000,
  maxProposalRunsPerTarget: 1,
});

const MAX_OPERATIONAL_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_OPERATIONAL_TIMEOUT_MS = 100;
const activeProposalTargets = new Set<string>();

export function resolveOperationalLimits(overrides: OperationalLimitOverrides = {}): OperationalLimits {
  return {
    overallRunTimeoutMs: boundedTimeout(overrides.overallRunTimeoutMs, DEFAULT_OPERATIONAL_LIMITS.overallRunTimeoutMs),
    scannerTimeoutMs: boundedTimeout(overrides.scannerTimeoutMs, DEFAULT_OPERATIONAL_LIMITS.scannerTimeoutMs),
    proposalOperationTimeoutMs: boundedTimeout(overrides.proposalOperationTimeoutMs, DEFAULT_OPERATIONAL_LIMITS.proposalOperationTimeoutMs),
    maxProposalRunsPerTarget: 1,
  };
}

export function tryAcquireProposalRunLock(normalizedRepositoryId: string): (() => void) | undefined {
  const key = normalizedRepositoryId.trim().toLowerCase();
  if (key.length === 0 || activeProposalTargets.has(key)) {
    return undefined;
  }
  activeProposalTargets.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeProposalTargets.delete(key);
  };
}

export class OperationalTimeoutError extends Error {
  readonly code = "RUN_TIMEOUT" as const;
  readonly stage: string;

  constructor(stage: string) {
    super("The run exceeded its configured execution deadline.");
    this.name = "OperationalTimeoutError";
    this.stage = stage;
  }
}

export async function withFiniteTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  const duration = boundedTimeout(timeoutMs, DEFAULT_OPERATIONAL_LIMITS.overallRunTimeoutMs);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new OperationalTimeoutError(stage));
    }, duration);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_OPERATIONAL_TIMEOUT_MS, Math.max(MIN_OPERATIONAL_TIMEOUT_MS, Math.floor(value as number)));
}