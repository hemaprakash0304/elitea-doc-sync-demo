import YAML from "yaml";
import { createObservation, containsSensitiveValue, sourceLocator } from "./observation.js";
import type {
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerOutput,
  TechnicalObservation,
  TechnologyAnalyzer,
} from "./types.js";

interface LogicalLine {
  text: string;
  line: number;
}

export class DockerAnalyzer implements TechnologyAnalyzer {
  readonly id = "docker" as const;

  analyze(input: AnalyzerInput): AnalyzerOutput {
    const observations: TechnicalObservation[] = [];
    const issues: AnalyzerIssue[] = [];
    for (const file of [...input.files].sort((left, right) => compareText(left.path, right.path))) {
      const basename = file.path.slice(file.path.lastIndexOf("/") + 1).toLowerCase();
      if (basename.startsWith("dockerfile")) {
        analyzeDockerfile(file.path, file.content, observations);
      } else if (basename === ".dockerignore") {
        analyzeDockerIgnore(file.path, file.content, observations);
      } else if (isComposeFile(basename)) {
        analyzeCompose(file.path, file.content, observations, issues);
      }
    }
    return { observations, issues };
  }
}

function analyzeDockerfile(path: string, content: string, observations: TechnicalObservation[]): void {
  for (const logicalLine of logicalLines(content)) {
    const instruction = /^\s*([A-Za-z]+)\s+(.*?)\s*$/.exec(logicalLine.text);
    if (instruction?.[1] === undefined || instruction[2] === undefined) {
      continue;
    }
    const directive = instruction[1].toUpperCase();
    const argument = instruction[2].trim();
    if (directive === "FROM") {
      const from = /^--platform=(?:\S+)\s+(.+)$/.exec(argument)?.[1] ?? argument;
      const match = /^([^\s]+)(?:\s+AS\s+([A-Za-z0-9_.-]+))?/i.exec(from);
      const image = match?.[1];
      const stage = match?.[2];
      if (image !== undefined) {
        emit(observations, {
          analyzer: "docker",
          category: "docker_base_image",
          name: "Docker base image",
          value: image,
          path,
          locator: sourceLocator(logicalLine.line),
          sourceKind: "dockerfile",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
        if (stage !== undefined) {
          emit(observations, {
            analyzer: "docker",
            category: "docker_build_stage",
            name: stage,
            value: image,
            attributes: { stageName: stage },
            path,
            locator: sourceLocator(logicalLine.line),
            sourceKind: "dockerfile",
            claimType: "declaration",
            verificationBasis: "structured_declaration",
            confidence: "High",
          });
        }
      }
    } else if (directive === "EXPOSE") {
      for (const port of argument.split(/\s+/).filter(Boolean)) {
        emit(observations, {
          analyzer: "docker",
          category: "docker_exposed_port",
          name: "Exposed port declaration",
          value: port,
          path,
          locator: sourceLocator(logicalLine.line),
          sourceKind: "dockerfile",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    } else if (directive === "RUN") {
      const safeCommand = safeBuildCommand(argument);
      if (safeCommand !== undefined) {
        emit(observations, {
          analyzer: "docker",
          category: "docker_build_command",
          name: "Docker RUN command",
          value: safeCommand,
          path,
          locator: sourceLocator(logicalLine.line),
          sourceKind: "dockerfile",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    } else if (directive === "ENV" || directive === "ARG") {
      const variableName = parseVariableName(argument);
      if (variableName !== undefined) {
        emit(observations, {
          analyzer: "docker",
          category: directive === "ENV" ? "docker_environment_variable" : "docker_build_argument",
          name: directive === "ENV" ? "Docker environment variable name" : "Docker build argument name",
          value: variableName,
          path,
          locator: sourceLocator(logicalLine.line),
          sourceKind: "dockerfile",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    }
  }
}

function analyzeCompose(
  path: string,
  content: string,
  observations: TechnicalObservation[],
  issues: AnalyzerIssue[],
): void {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content, { uniqueKeys: true, maxAliasCount: 0, schema: "core" });
  } catch {
    issues.push({ analyzer: "docker", code: "INVALID_YAML", path });
    return;
  }
  const root = asRecord(parsed);
  const services = asRecord(root?.services);
  if (services === undefined) {
    return;
  }

  for (const serviceName of Object.keys(services).sort(compareText)) {
    const service = asRecord(services[serviceName]);
    if (service === undefined) {
      continue;
    }
    const locator = `services.${serviceName}`;
    emit(observations, {
      analyzer: "docker",
      category: "compose_service",
      name: serviceName,
      value: "declared Compose service",
      path,
      locator,
      sourceKind: "configuration",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });

    const image = stringValue(service.image);
    if (image !== undefined) {
      emit(observations, {
        analyzer: "docker",
        category: "docker_base_image",
        name: `Compose service ${serviceName} image`,
        value: image,
        path,
        locator: `${locator}.image`,
        sourceKind: "configuration",
        claimType: "declaration",
        verificationBasis: "structured_declaration",
        confidence: "High",
      });
    }

    for (const port of asArray(service.ports)) {
      const value = scalarValue(port);
      if (value !== undefined) {
        emit(observations, {
          analyzer: "docker",
          category: "compose_port",
          name: `Compose service ${serviceName} port`,
          value,
          path,
          locator: `${locator}.ports`,
          sourceKind: "configuration",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    }
    for (const volume of asArray(service.volumes)) {
      const value = scalarValue(volume);
      if (value !== undefined) {
        emit(observations, {
          analyzer: "docker",
          category: "compose_volume",
          name: `Compose service ${serviceName} volume`,
          value,
          path,
          locator: `${locator}.volumes`,
          sourceKind: "configuration",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    }
    for (const network of asArray(service.networks)) {
      const value = scalarValue(network);
      if (value !== undefined) {
        emit(observations, {
          analyzer: "docker",
          category: "compose_network",
          name: `Compose service ${serviceName} network`,
          value,
          path,
          locator: `${locator}.networks`,
          sourceKind: "configuration",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    }
    for (const variableName of environmentVariableNames(service.environment)) {
      emit(observations, {
        analyzer: "docker",
        category: "compose_environment_variable",
        name: `Compose service ${serviceName} environment variable name`,
        value: variableName,
        path,
        locator: `${locator}.environment.${variableName}`,
        sourceKind: "configuration",
        claimType: "declaration",
        verificationBasis: "structured_declaration",
        confidence: "High",
      });
    }
    for (const buildCommand of asArray(asRecord(service.build)?.args)) {
      const value = scalarValue(buildCommand);
      if (value !== undefined && !containsSensitiveValue(value)) {
        emit(observations, {
          analyzer: "docker",
          category: "docker_build_argument",
          name: `Compose service ${serviceName} build argument`,
          value: value.split("=", 1)[0] ?? value,
          path,
          locator: `${locator}.build.args`,
          sourceKind: "configuration",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
    }
  }

  for (const [networkName] of Object.entries(asRecord(root?.networks) ?? {}).sort(([left], [right]) => compareText(left, right))) {
    emit(observations, {
      analyzer: "docker",
      category: "compose_network",
      name: networkName,
      value: "declared Compose network",
      path,
      locator: `networks.${networkName}`,
      sourceKind: "configuration",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
  }
}

function analyzeDockerIgnore(path: string, content: string, observations: TechnicalObservation[]): void {
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const pattern = line.trim();
    if (pattern.length === 0 || pattern.startsWith("#") || containsSensitiveValue(pattern)) {
      continue;
    }
    emit(observations, {
      analyzer: "docker",
      category: "docker_ignore_pattern",
      name: "Docker ignore pattern",
      value: pattern,
      path,
      locator: sourceLocator(index + 1),
      sourceKind: "configuration",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
  }
}

function logicalLines(content: string): LogicalLine[] {
  const result: LogicalLine[] = [];
  let current = "";
  let startLine = 1;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (current.length === 0) {
      startLine = index + 1;
    }
    current += `${current.length === 0 ? "" : " "}${line.trim().replace(/\\\s*$/, "")}`;
    if (/\\\s*$/.test(line)) {
      continue;
    }
    result.push({ text: current, line: startLine });
    current = "";
  }
  if (current.length > 0) {
    result.push({ text: current, line: startLine });
  }
  return result;
}

function safeBuildCommand(command: string): string | undefined {
  return containsSensitiveValue(command) ? undefined : command.replace(/\s+/g, " ").trim();
}

function parseVariableName(argument: string): string | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(argument);
  return match?.[1];
}

function environmentVariableNames(environment: unknown): string[] {
  if (Array.isArray(environment)) {
    return environment.flatMap((item) => {
      const text = scalarValue(item);
      const name = text?.split("=", 1)[0];
      return name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? [name] : [];
    }).sort(compareText);
  }
  const object = asRecord(environment);
  return object === undefined ? [] : Object.keys(object).sort(compareText);
}

function isComposeFile(basename: string): boolean {
  return /^(?:docker-)?compose(?:\.[a-z0-9_-]+)?\.ya?ml$/.test(basename);
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

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function scalarValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    return text.length === 0 ? undefined : text;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}