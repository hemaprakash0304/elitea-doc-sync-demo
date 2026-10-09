import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createObservation, sourceLocator } from "./observation.js";
import type {
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerOutput,
  TechnicalObservation,
  TechnologyAnalyzer,
} from "./types.js";

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  parseTagValue: false,
  trimValues: true,
});

export class JavaMavenAnalyzer implements TechnologyAnalyzer {
  readonly id = "java_maven" as const;

  analyze(input: AnalyzerInput): AnalyzerOutput {
    const observations: TechnicalObservation[] = [];
    const issues: AnalyzerIssue[] = [];
    const files = [...input.files].sort((left, right) => compareText(left.path, right.path));

    for (const file of files) {
      const path = file.path.toLowerCase();
      if (path.endsWith("pom.xml")) {
        analyzePom(file.path, file.content, observations, issues);
      } else if (path.endsWith(".java")) {
        analyzeJavaSource(file.path, file.content, observations);
      } else if (path.endsWith(".properties") && path.endsWith("maven-wrapper.properties")) {
        analyzeMavenWrapper(file.path, file.content, observations);
      }
    }

    return { observations, issues };
  }
}

function analyzePom(
  path: string,
  content: string,
  observations: TechnicalObservation[],
  issues: AnalyzerIssue[],
): void {
  if (XMLValidator.validate(content) !== true) {
    issues.push({ analyzer: "java_maven", code: "INVALID_XML", path });
    return;
  }

  let parsed: unknown;
  try {
    parsed = XML_PARSER.parse(content);
  } catch {
    issues.push({ analyzer: "java_maven", code: "INVALID_XML", path });
    return;
  }
  const project = asRecord(asRecord(parsed)?.project);
  if (project === undefined) {
    issues.push({ analyzer: "java_maven", code: "INVALID_XML", path });
    return;
  }

  const coordinateFields = ["groupId", "artifactId", "version", "packaging"] as const;
  for (const field of coordinateFields) {
    const value = stringValue(project[field]);
    if (value !== undefined) {
      push(observations, {
        analyzer: "java_maven",
        category: "project_coordinate",
        name: field,
        value,
        path,
        locator: `project.${field}`,
        sourceKind: "manifest",
        claimType: "declaration",
        verificationBasis: "manifest_declaration",
        confidence: "High",
      });
    }
  }

  const properties = asRecord(project.properties);
  for (const property of ["maven.compiler.release", "maven.compiler.source", "maven.compiler.target", "java.version"]) {
    const value = properties === undefined ? undefined : stringValue(properties[property]);
    if (value !== undefined) {
      push(observations, {
        analyzer: "java_maven",
        category: "java_language_level",
        name: property,
        value,
        path,
        locator: `project.properties.${property}`,
        sourceKind: "manifest",
        claimType: "declaration",
        verificationBasis: "manifest_declaration",
        confidence: "High",
      });
    }
  }

  analyzeDependencies(path, project.dependencies, "project.dependencies", observations);
  const dependencyManagement = asRecord(project.dependencyManagement);
  if (dependencyManagement !== undefined) {
    analyzeDependencies(
      path,
      asRecord(dependencyManagement.dependencies),
      "project.dependencyManagement.dependencies",
      observations,
    );
  }

  const build = asRecord(project.build);
  if (build !== undefined) {
    analyzePlugins(path, asRecord(build.plugins), "project.build.plugins", observations);
    const pluginManagement = asRecord(build.pluginManagement);
    if (pluginManagement !== undefined) {
      const managedBuild = asRecord(pluginManagement.plugins);
      analyzePlugins(path, managedBuild, "project.build.pluginManagement.plugins", observations);
    }
  }
}

function analyzeDependencies(
  path: string,
  section: unknown,
  locatorPrefix: string,
  observations: TechnicalObservation[],
): void {
  const dependencies = asRecord(section);
  if (dependencies === undefined) {
    return;
  }
  for (const [index, dependency] of asArray(dependencies.dependency).entries()) {
    const item = asRecord(dependency);
    if (item === undefined) {
      continue;
    }
    const groupId = stringValue(item.groupId);
    const artifactId = stringValue(item.artifactId);
    if (groupId === undefined || artifactId === undefined) {
      continue;
    }
    const version = stringValue(item.version);
    const scope = stringValue(item.scope);
    push(observations, {
      analyzer: "java_maven",
      category: "dependency",
      name: `${groupId}:${artifactId}`,
      value: version ?? "Version not specified",
      ...(scope === undefined ? {} : { attributes: { scope } }),
      path,
      locator: `${locatorPrefix}.dependency[${index}]`,
      sourceKind: "manifest",
      claimType: "declaration",
      status: version === undefined ? "Unable to Verify" : "Verified",
      verificationBasis: "manifest_declaration",
      confidence: version === undefined ? "Medium" : "High",
    });
  }
}

function analyzePlugins(
  path: string,
  section: Record<string, unknown> | undefined,
  locatorPrefix: string,
  observations: TechnicalObservation[],
): void {
  if (section === undefined) {
    return;
  }
  for (const [index, plugin] of asArray(section.plugin).entries()) {
    const item = asRecord(plugin);
    if (item === undefined) {
      continue;
    }
    const artifactId = stringValue(item.artifactId);
    if (artifactId === undefined) {
      continue;
    }
    const groupId = stringValue(item.groupId) ?? "org.apache.maven.plugins";
    push(observations, {
      analyzer: "java_maven",
      category: "build_plugin",
      name: `${groupId}:${artifactId}`,
      value: stringValue(item.version) ?? "declared without a version",
      path,
      locator: `${locatorPrefix}.plugin[${index}]`,
      sourceKind: "manifest",
      claimType: "declaration",
      verificationBasis: "manifest_declaration",
      confidence: "High",
    });
    if (artifactId === "maven-compiler-plugin") {
      const configuration = asRecord(item.configuration);
      for (const setting of ["release", "source", "target"] as const) {
        const languageLevel = configuration === undefined ? undefined : stringValue(configuration[setting]);
        if (languageLevel !== undefined) {
          push(observations, {
            analyzer: "java_maven",
            category: "java_language_level",
            name: `maven-compiler-plugin.${setting}`,
            value: languageLevel,
            path,
            locator: `${locatorPrefix}.plugin[${index}].configuration.${setting}`,
            sourceKind: "manifest",
            claimType: "declaration",
            verificationBasis: "manifest_declaration",
            confidence: "High",
          });
        }
      }
    }
  }
}

function analyzeMavenWrapper(path: string, content: string, observations: TechnicalObservation[]): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const property = /^\s*distributionUrl\s*=\s*([^\s#]+)/.exec(line);
    if (property?.[1] === undefined) {
      continue;
    }
    const version = /apache-maven-([0-9]+(?:\.[0-9A-Za-z_-]+)*)-bin\.(?:zip|tar\.gz)/i.exec(property[1])?.[1];
    if (version !== undefined) {
      push(observations, {
        analyzer: "java_maven",
        category: "maven_wrapper_version",
        name: "Maven Wrapper",
        value: version,
        path,
        locator: sourceLocator(index + 1),
        sourceKind: "configuration",
        claimType: "declaration",
        verificationBasis: "structured_declaration",
        confidence: "High",
      });
    }
  }
}

function analyzeJavaSource(path: string, content: string, observations: TechnicalObservation[]): void {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const packageName = /^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/.exec(line)?.[1];
    if (packageName !== undefined) {
      push(observations, {
        analyzer: "java_maven",
        category: "java_package",
        name: "Java package",
        value: packageName,
        path,
        locator: sourceLocator(index + 1),
        sourceKind: "source",
        claimType: "source_reference",
        verificationBasis: "direct_source_pattern",
        confidence: "Medium",
      });
    }
    const imported = /^\s*import\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\.\*)?)\s*;/.exec(line)?.[1];
    if (imported !== undefined) {
      push(observations, {
        analyzer: "java_maven",
        category: "java_import",
        name: "Java import",
        value: imported,
        path,
        locator: sourceLocator(index + 1),
        sourceKind: "source",
        claimType: "source_reference",
        verificationBasis: "direct_source_pattern",
        confidence: "Medium",
      });
    }
  }
}

function push(output: TechnicalObservation[], observation: Parameters<typeof createObservation>[0]): void {
  const safe = createObservation(observation);
  if (safe !== undefined) {
    output.push(safe);
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

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length === 0 ? undefined : value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}