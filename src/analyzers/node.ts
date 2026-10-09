import YAML from "yaml";
import { createObservation, sourceLocator } from "./observation.js";
import type {
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerOutput,
  TechnicalObservation,
  TechnologyAnalyzer,
} from "./types.js";

const TEST_TOOL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bjest\b/i, "Jest"],
  [/\bvitest\b/i, "Vitest"],
  [/\bmocha\b/i, "Mocha"],
  [/\btap\b/i, "Tap"],
  [/\bava\b/i, "AVA"],
  [/\bcypress\b/i, "Cypress"],
  [/\bplaywright\b/i, "Playwright"],
  [/\bwebdriverio\b/i, "WebdriverIO"],
];
const DIRECT_SCOPES = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
type DependencyScope = typeof DIRECT_SCOPES[number];
type DependencyMap = Map<string, { scope: DependencyScope; declared: string }>;

interface PackageManifest {
  path: string;
  directDependencies: DependencyMap;
}

export class JavaScriptNodeAnalyzer implements TechnologyAnalyzer {
  readonly id = "javascript_node" as const;

  analyze(input: AnalyzerInput): AnalyzerOutput {
    const observations: TechnicalObservation[] = [];
    const issues: AnalyzerIssue[] = [];
    const files = [...input.files].sort((left, right) => compareText(left.path, right.path));
    const manifests = new Map<string, PackageManifest>();

    for (const file of files) {
      if (basename(file.path).toLowerCase() !== "package.json") {
        continue;
      }
      const parsed = parseJson(file.path, file.content, issues);
      if (parsed === undefined) {
        continue;
      }
      const manifest = asRecord(parsed);
      if (manifest === undefined) {
        issues.push({ analyzer: "javascript_node", code: "INVALID_JSON", path: file.path });
        continue;
      }
      const directDependencies = readDependencies(manifest);
      manifests.set(directory(file.path), { path: file.path, directDependencies });
      analyzeManifest(file.path, manifest, directDependencies, observations);
    }

    for (const file of files) {
      const name = basename(file.path).toLowerCase();
      if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
        analyzeNpmLock(file.path, file.content, manifests, observations, issues);
      } else if (name === "yarn.lock") {
        analyzeYarnLock(file.path, file.content, manifests, observations, issues);
      } else if (name === "pnpm-lock.yaml") {
        analyzePnpmLock(file.path, file.content, manifests, observations, issues);
      } else if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(file.path)) {
        analyzeImports(file.path, file.content, observations);
      }
    }
    return { observations, issues };
  }
}

function analyzeManifest(
  path: string,
  manifest: Record<string, unknown>,
  directDependencies: DependencyMap,
  observations: TechnicalObservation[],
): void {
  const name = stringValue(manifest.name);
  if (name !== undefined) {
    push(observations, {
      analyzer: "javascript_node",
      category: "package_name",
      name: "Package name",
      value: name,
      path,
      locator: "package.json:name",
      sourceKind: "manifest",
      claimType: "declaration",
      verificationBasis: "manifest_declaration",
      confidence: "High",
    });
  }
  const description = stringValue(manifest.description);
  if (description !== undefined) {
    push(observations, {
      analyzer: "javascript_node",
      category: "package_description",
      name: "Package description",
      value: description,
      path,
      locator: "package.json:description",
      sourceKind: "manifest",
      claimType: "declaration",
      verificationBasis: "manifest_declaration",
      confidence: "High",
    });
  }

  const engines = asRecord(manifest.engines);
  const nodeConstraint = engines === undefined ? undefined : stringValue(engines.node);
  if (nodeConstraint !== undefined) {
    push(observations, {
      analyzer: "javascript_node",
      category: "node_engine_constraint",
      name: "engines.node",
      value: nodeConstraint,
      path,
      locator: "package.json:engines.node",
      sourceKind: "manifest",
      claimType: "declaration",
      verificationBasis: "manifest_declaration",
      confidence: "High",
    });
  }

  for (const [dependencyName, dependency] of directDependencies) {
    push(observations, {
      analyzer: "javascript_node",
      category: "dependency",
      name: dependencyName,
      value: dependency.declared,
      attributes: { scope: dependency.scope, versionKind: "declared_specifier" },
      path,
      locator: `package.json:${dependency.scope}.${dependencyName}`,
      sourceKind: "manifest",
      claimType: "declaration",
      verificationBasis: "manifest_declaration",
      confidence: "High",
    });
  }

  const scripts = asRecord(manifest.scripts);
  if (scripts !== undefined) {
    for (const scriptName of Object.keys(scripts).sort(compareText)) {
      const command = stringValue(scripts[scriptName]);
      if (command === undefined) {
        continue;
      }
      const category = /^(?:test|test:|check|lint)/i.test(scriptName) ? "test_command" : "build_command";
      push(observations, {
        analyzer: "javascript_node",
        category,
        name: `npm script ${scriptName}`,
        value: command,
        attributes: { scriptName },
        path,
        locator: `package.json:scripts.${scriptName}`,
        sourceKind: "manifest",
        claimType: "declaration",
        verificationBasis: "manifest_declaration",
        confidence: "High",
      });
      if (category === "test_command") {
        emitTestTools(path, `package.json:scripts.${scriptName}`, command, observations);
      }
    }
  }

  for (const [dependencyName, dependency] of directDependencies) {
    emitTestTools(path, `package.json:${dependency.scope}.${dependencyName}`, dependencyName, observations);
  }
}

function analyzeNpmLock(
  path: string,
  content: string,
  manifests: Map<string, PackageManifest>,
  observations: TechnicalObservation[],
  issues: AnalyzerIssue[],
): void {
  const parsed = parseJson(path, content, issues);
  if (parsed === undefined) {
    return;
  }
  const lock = asRecord(parsed);
  if (lock === undefined) {
    issues.push({ analyzer: "javascript_node", code: "INVALID_LOCKFILE", path });
    return;
  }
  const manifest = manifests.get(directory(path));
  if (manifest === undefined) {
    return;
  }
  const packages = asRecord(lock.packages);
  const legacyDependencies = asRecord(lock.dependencies);
  const rootPackage = packages === undefined ? undefined : asRecord(packages[""]);
  const lockDirectNames = new Set(manifest.directDependencies.keys());
  if (rootPackage !== undefined) {
    for (const scope of DIRECT_SCOPES) {
      const entries = asRecord(rootPackage[scope]);
      if (entries !== undefined) {
        Object.keys(entries).forEach((name) => lockDirectNames.add(name));
      }
    }
  }

  for (const dependencyName of [...lockDirectNames].sort(compareText)) {
    let version: string | undefined;
    if (packages !== undefined) {
      const exactPath = asRecord(packages[`node_modules/${dependencyName}`]);
      version = exactPath === undefined
        ? findNestedNpmVersion(packages, dependencyName)
        : stringValue(exactPath.version);
    }
    if (version === undefined && legacyDependencies !== undefined) {
      version = findLegacyNpmVersion(legacyDependencies, dependencyName);
    }
    if (version !== undefined) {
      emitResolvedVersion(path, `package-lock.json:packages[node_modules/${dependencyName}].version`, dependencyName, version, observations);
    }
  }
}

function analyzeYarnLock(
  path: string,
  content: string,
  manifests: Map<string, PackageManifest>,
  observations: TechnicalObservation[],
  issues: AnalyzerIssue[],
): void {
  const manifest = manifests.get(directory(path));
  if (manifest === undefined) {
    return;
  }
  let selectors: string[] = [];
  let resolvedNames: string[] = [];
  let resolvedVersion: string | undefined;
  let foundVersion = false;
  const flush = () => {
    if (foundVersion && resolvedVersion !== undefined) {
      for (const name of resolvedNames) {
        if (manifest.directDependencies.has(name)) {
          emitResolvedVersion(path, `yarn.lock:${selectors.join(",")}.version`, name, resolvedVersion, observations);
        }
      }
    }
  };

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.length > 0 && !/^\s/.test(line) && line.endsWith(":")) {
      flush();
      selectors = splitYarnSelectors(line.slice(0, -1));
      resolvedNames = selectors.map(packageNameFromYarnSelector).filter((name): name is string => name !== undefined);
      resolvedVersion = undefined;
      foundVersion = false;
      continue;
    }
    const version = /^\s+version\s+(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (version !== null) {
      resolvedVersion = version[1] ?? version[2] ?? version[3];
      foundVersion = resolvedVersion !== undefined;
    }
    if (index === content.split(/\r?\n/).length - 1) {
      flush();
    }
  }
  if (content.length > 0 && !content.endsWith("\n")) {
    flush();
  }

  if (content.trim().length > 0 && !/^# yarn lockfile/i.test(content.trimStart()) &&
    !/^__metadata:/m.test(content)) {
    issues.push({ analyzer: "javascript_node", code: "INVALID_LOCKFILE", path });
  }
}

function analyzePnpmLock(
  path: string,
  content: string,
  manifests: Map<string, PackageManifest>,
  observations: TechnicalObservation[],
  issues: AnalyzerIssue[],
): void {
  const manifest = manifests.get(directory(path));
  if (manifest === undefined) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(content, { uniqueKeys: true, maxAliasCount: 0, schema: "core" });
  } catch {
    issues.push({ analyzer: "javascript_node", code: "INVALID_LOCKFILE", path });
    return;
  }
  const lock = asRecord(parsed);
  if (lock === undefined) {
    issues.push({ analyzer: "javascript_node", code: "INVALID_LOCKFILE", path });
    return;
  }
  const importers = asRecord(lock.importers);
  const rootImporter = importers === undefined ? undefined : asRecord(importers["."]);
  if (rootImporter === undefined) {
    return;
  }
  for (const scope of DIRECT_SCOPES) {
    const entries = asRecord(rootImporter[scope]);
    if (entries === undefined) {
      continue;
    }
    for (const dependencyName of Object.keys(entries).sort(compareText)) {
      if (!manifest.directDependencies.has(dependencyName)) {
        continue;
      }
      const record = asRecord(entries[dependencyName]);
      const version = stringValue(record?.version);
      if (version !== undefined) {
        emitResolvedVersion(path, `pnpm-lock.yaml:importers..${scope}.${dependencyName}.version`, dependencyName, version, observations);
      }
    }
  }
}

function analyzeImports(path: string, content: string, observations: TechnicalObservation[]): void {
  const pattern = /\b(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|require\s*\(\s*)["']([^"']+)["']/g;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    for (const match of line.matchAll(pattern)) {
      const moduleName = match[1];
      if (moduleName === undefined || moduleName.startsWith(".") || moduleName.startsWith("/") || moduleName.startsWith("#")) {
        continue;
      }
      push(observations, {
        analyzer: "javascript_node",
        category: "node_module_reference",
        name: "Imported module reference",
        value: moduleName,
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

function emitTestTools(path: string, locator: string, sourceText: string, observations: TechnicalObservation[]): void {
  for (const [pattern, tool] of TEST_TOOL_PATTERNS) {
    if (pattern.test(sourceText)) {
      push(observations, {
        analyzer: "javascript_node",
        category: "test_tool",
        name: "Test tooling reference",
        value: tool,
        path,
        locator,
        sourceKind: "manifest",
        claimType: "declaration",
        verificationBasis: "manifest_declaration",
        confidence: "Medium",
      });
    }
  }
}

function emitResolvedVersion(
  path: string,
  locator: string,
  dependencyName: string,
  version: string,
  observations: TechnicalObservation[],
): void {
  push(observations, {
    analyzer: "javascript_node",
    category: "dependency",
    name: dependencyName,
    value: version,
    attributes: { versionKind: "lockfile_resolved" },
    path,
    locator,
    sourceKind: "lockfile",
    claimType: "declaration",
    verificationBasis: "lockfile_resolution",
    confidence: "High",
  });
}

function readDependencies(manifest: Record<string, unknown>): DependencyMap {
  const dependencies: DependencyMap = new Map();
  for (const scope of DIRECT_SCOPES) {
    const section = asRecord(manifest[scope]);
    if (section === undefined) {
      continue;
    }
    for (const name of Object.keys(section).sort(compareText)) {
      const declared = stringValue(section[name]);
      if (declared !== undefined) {
        dependencies.set(name, { scope, declared });
      }
    }
  }
  return dependencies;
}

function parseJson(path: string, content: string, issues: AnalyzerIssue[]): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    issues.push({ analyzer: "javascript_node", code: path.toLowerCase().endsWith("package.json") ? "INVALID_JSON" : "INVALID_LOCKFILE", path });
    return undefined;
  }
}

function findNestedNpmVersion(packages: Record<string, unknown>, dependencyName: string): string | undefined {
  const suffix = `/node_modules/${dependencyName}`;
  const matchingKeys = Object.keys(packages).filter((key) => key.endsWith(suffix)).sort(compareText);
  for (const key of matchingKeys) {
    const version = stringValue(asRecord(packages[key])?.version);
    if (version !== undefined) {
      return version;
    }
  }
  return undefined;
}

function findLegacyNpmVersion(dependencies: Record<string, unknown>, dependencyName: string): string | undefined {
  const direct = asRecord(dependencies[dependencyName]);
  if (direct !== undefined) {
    return stringValue(direct.version);
  }
  for (const child of Object.values(dependencies)) {
    const nested = asRecord(asRecord(child)?.dependencies);
    if (nested !== undefined) {
      const version = findLegacyNpmVersion(nested, dependencyName);
      if (version !== undefined) {
        return version;
      }
    }
  }
  return undefined;
}

function splitYarnSelectors(header: string): string[] {
  return header.match(/(?:"[^"]+"|'[^']+'|[^,]+)(?:,\s*|$)/g)
    ?.map((selector) => selector.replace(/,$/, "").trim().replace(/^['"]|['"]$/g, ""))
    .filter((selector) => selector.length > 0) ?? [];
}

function packageNameFromYarnSelector(selector: string): string | undefined {
  const atIndex = selector.lastIndexOf("@");
  if (atIndex <= 0) {
    return undefined;
  }
  return selector.slice(0, atIndex);
}

function directory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
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

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}