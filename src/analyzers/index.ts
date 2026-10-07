import { DocumentationAnalyzer } from "./documentation.js";
import { DockerAnalyzer } from "./docker.js";
import { GitHubActionsAnalyzer } from "./github-actions.js";
import { JavaMavenAnalyzer } from "./java-maven.js";
import { JavaScriptNodeAnalyzer } from "./node.js";
import type { TechnologyAnalyzer } from "./types.js";

export { createAnalyzerInput, AnalyzerInputError, runTechnologyAnalyzers } from "./runner.js";
export type * from "./types.js";

export const DEFAULT_TECHNOLOGY_ANALYZERS: readonly TechnologyAnalyzer[] = Object.freeze([
  new JavaMavenAnalyzer(),
  new JavaScriptNodeAnalyzer(),
  new DockerAnalyzer(),
  new GitHubActionsAnalyzer(),
  new DocumentationAnalyzer(),
]);