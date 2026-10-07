import { containsSensitiveValue, createObservation, sourceLocator } from "./observation.js";
import type {
  AnalyzerInput,
  AnalyzerOutput,
  TechnicalObservation,
  TechnologyAnalyzer,
} from "./types.js";

const TECHNOLOGY_NAMES = [
  "GitHub Actions", "JavaScript", "TypeScript", "Node.js", "Spring Boot", "Spring", "Maven",
  "Docker", "React", "Angular", "Vue.js", "Express", "NestJS", "Jest", "Vitest", "Mocha",
  "PostgreSQL", "MySQL", "MariaDB", "SQLite", "MongoDB", "Redis", "Elasticsearch", "OpenAPI",
  "GraphQL", "Terraform", "Kubernetes", "Python", "Go", "Rust", ".NET",
] as const;
const TECHNOLOGY_PATTERN = new RegExp(`\\b(?:${TECHNOLOGY_NAMES.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|")})\\b`, "gi");
const UNSUPPORTED_TECHNOLOGIES = new Set([".NET", "Elasticsearch", "Go", "Kubernetes", "Python", "Rust", "Terraform"]);
const TECHNICAL_CONFIG_KEY = /(?:^|[._-])(?:java|maven|node|runtime|framework|database|language|build|test)(?:[._-]|$)/i;
const SENSITIVE_CONFIG_KEY = /(?:password|passwd|token|secret|credential|private.?key|authorization|\.url$)/i;
const DOCUMENTED_COMMAND = /^\s*(?:[-*+]\s+)?(?:`?\$?\s*)?(mvnw?(?:\s|$)|mvn\s|npm\s+(?:run|test|install)|npx\s|node\s|docker\s+(?:build|compose)|pnpm\s|yarn\s)/i;

export class DocumentationAnalyzer implements TechnologyAnalyzer {
  readonly id = "documentation" as const;

  analyze(input: AnalyzerInput): AnalyzerOutput {
    const observations: TechnicalObservation[] = [];
    const files = [...input.files].sort((left, right) => compareText(left.path, right.path));
    const manifestNames = readPackageNames(files);

    for (const file of files) {
      const extension = file.extension?.toLowerCase();
      if ([".md", ".rst", ".adoc"].includes(extension ?? "") || /^readme/i.test(basename(file.path))) {
        analyzeDocumentation(file.path, file.content, manifestNames.get(directory(file.path)), observations);
      } else if ([".properties", ".ini", ".cfg", ".conf", ".toml"].includes(extension ?? "")) {
        analyzeConfiguration(file.path, file.content, observations);
      }
    }
    return { observations, issues: [] };
  }
}

function analyzeDocumentation(
  path: string,
  content: string,
  manifestName: string | undefined,
  observations: TechnicalObservation[],
): void {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const projectName = /^\s*(?:project|application|package)\s+name\s*:\s*(.+?)\s*$/i.exec(line)?.[1];
    if (projectName !== undefined && !containsSensitiveValue(projectName)) {
      const normalizedName = projectName.replace(/[`*_]/g, "").trim();
      if (normalizedName.length > 0) {
        emit(observations, {
          analyzer: "documentation",
          category: "package_name",
          name: "Documented project name",
          value: normalizedName,
          path,
          locator: sourceLocator(index + 1),
          sourceKind: "documentation",
          claimType: "documentation_claim",
          status: manifestName !== undefined && manifestName !== normalizedName ? "Conflict" : "Verified",
          verificationBasis: "documentation_claim",
          confidence: "Low",
        });
      }
    }

    const command = extractDocumentedCommand(line);
    if (command !== undefined && command.length > 0 && !containsSensitiveValue(command)) {
      emit(observations, {
        analyzer: "documentation",
        category: "documented_command",
        name: "Documented command",
        value: command,
        path,
        locator: sourceLocator(index + 1),
        sourceKind: "documentation",
        claimType: "documentation_claim",
        verificationBasis: "documentation_claim",
        confidence: "Low",
      });
    }

    TECHNOLOGY_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(TECHNOLOGY_PATTERN)) {
      const technology = match[0];
      const unsupported = UNSUPPORTED_TECHNOLOGIES.has(technology);
      emit(observations, {
        analyzer: "documentation",
        category: unsupported ? "unsupported_technology" : "documentation_technology_claim",
        name: unsupported ? "Unsupported technology mention" : "Documented technology claim",
        value: technology,
        path,
        locator: sourceLocator(index + 1),
        sourceKind: "documentation",
        claimType: "documentation_claim",
        ...(unsupported ? { status: "Unable to Verify" as const } : {}),
        verificationBasis: unsupported ? "unsupported_technology_mention" : "documentation_claim",
        confidence: "Low",
      });
    }
  }
}

function analyzeConfiguration(path: string, content: string, observations: TechnicalObservation[]): void {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const entry = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:)\s*(.*?)\s*$/.exec(line);
    const key = entry?.[1];
    const rawValue = entry?.[2];
    if (key === undefined || rawValue === undefined || !TECHNICAL_CONFIG_KEY.test(key) || SENSITIVE_CONFIG_KEY.test(key)) {
      continue;
    }
    const value = rawValue.replace(/\s+#.*$/, "").replace(/^['"]|['"]$/g, "").trim();
    if (value.length === 0 || containsSensitiveValue(value)) {
      continue;
    }
    emit(observations, {
      analyzer: "documentation",
      category: "configuration_reference",
      name: key,
      value,
      attributes: { key },
      path,
      locator: sourceLocator(index + 1),
      sourceKind: "configuration",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "Medium",
    });
  }
}

function readPackageNames(files: AnalyzerInput["files"]): Map<string, string> {
  const names = new Map<string, string>();
  for (const file of files) {
    if (basename(file.path).toLowerCase() !== "package.json") {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(file.content);
      const record = asRecord(parsed);
      const name = typeof record?.name === "string" ? record.name.trim() : undefined;
      if (name !== undefined && name.length > 0 && !containsSensitiveValue(name)) {
        names.set(directory(file.path), name);
      }
    } catch {
      continue;
    }
  }
  return names;
}

function emit(output: TechnicalObservation[], input: Parameters<typeof createObservation>[0]): void {
  const observation = createObservation(input);
  if (observation !== undefined) {
    output.push(observation);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function directory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function extractDocumentedCommand(line: string): string | undefined {
  const inlineCommand = /`((?:mvnw?|mvn|npm|npx|node|docker|pnpm|yarn)\s+[^`]+)`/i.exec(line)?.[1];
  const command = inlineCommand ?? DOCUMENTED_COMMAND.exec(line)?.[0]
    .replace(/^[\s>*`-]+/, "")
    .replace(/^\$\s*/, "")
    .replace(/`$/, "")
    .trim();
  return command !== undefined && command.length > 0 && !containsSensitiveValue(command) ? command : undefined;
}