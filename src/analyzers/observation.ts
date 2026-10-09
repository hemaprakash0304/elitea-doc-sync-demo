import type {
  AnalyzerId,
  ObservationClaimType,
  ObservationConfidence,
  ObservationSource,
  ObservationSourceKind,
  ObservationStatus,
  TechnicalObservation,
  VerificationBasis,
} from "./types.js";

const SENSITIVE_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])?(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

export interface ObservationInput {
  analyzer: AnalyzerId;
  category: TechnicalObservation["category"];
  name: string;
  value: string;
  path: string;
  locator: string;
  sourceKind: ObservationSourceKind;
  claimType: ObservationClaimType;
  verificationBasis: VerificationBasis;
  confidence: ObservationConfidence;
  status?: ObservationStatus;
  attributes?: Readonly<Record<string, string>>;
}

export function createObservation(input: ObservationInput): TechnicalObservation | undefined {
  const name = normalizeValue(input.name);
  const value = normalizeValue(input.value);
  const path = normalizeValue(input.path);
  const locator = normalizeValue(input.locator);
  if (name.length === 0 || value.length === 0 || path.length === 0 || locator.length === 0) {
    return undefined;
  }

  const attributes = input.attributes === undefined
    ? undefined
    : normalizeAttributes(input.attributes);
  if ([name, value, path, locator, ...Object.keys(attributes ?? {}), ...Object.values(attributes ?? {})].some(containsSensitiveValue)) {
    return undefined;
  }

  return {
    analyzer: input.analyzer,
    category: input.category,
    name,
    value,
    ...(attributes === undefined || Object.keys(attributes).length === 0 ? {} : { attributes }),
    source: { path, locator, kind: input.sourceKind } satisfies ObservationSource,
    claimType: input.claimType,
    status: input.status ?? "Verified",
    verificationBasis: input.verificationBasis,
    confidence: input.confidence,
  };
}

export function containsSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function sourceLocator(line: number): string {
  return `line:${line}`;
}

export function normalizeValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeAttributes(attributes: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attributes)
      .map(([key, value]) => [normalizeValue(key), normalizeValue(value)] as const)
      .filter(([key, value]) => key.length > 0 && value.length > 0)
      .sort(([left], [right]) => compareText(left, right)),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}