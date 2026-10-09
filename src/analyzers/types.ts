import type { FilteredAnalysisFile } from "../filter.js";

export type AnalyzerId = "java_maven" | "javascript_node" | "docker" | "github_actions" | "documentation";
export type ObservationConfidence = "High" | "Medium" | "Low";
export type ObservationClaimType = "declaration" | "source_reference" | "documentation_claim";
export type ObservationSourceKind = "manifest" | "lockfile" | "source" | "configuration" | "workflow" | "dockerfile" | "documentation";
export type ObservationStatus = "Verified" | "Not Specified" | "Unable to Verify" | "Conflict";
export type VerificationBasis =
  | "structured_declaration"
  | "manifest_declaration"
  | "lockfile_resolution"
  | "direct_source_pattern"
  | "documentation_claim"
  | "unsupported_technology_mention";

export type ObservationCategory =
  | "project_coordinate"
  | "java_language_level"
  | "maven_wrapper_version"
  | "dependency"
  | "build_plugin"
  | "build_command"
  | "test_command"
  | "java_package"
  | "java_import"
  | "configuration_variable"
  | "configuration_reference"
  | "infrastructure_resource"
  | "package_name"
  | "package_description"
  | "node_engine_constraint"
  | "package_script"
  | "test_tool"
  | "node_module_reference"
  | "docker_base_image"
  | "docker_build_stage"
  | "docker_exposed_port"
  | "docker_build_command"
  | "docker_environment_variable"
  | "docker_build_argument"
  | "docker_ignore_pattern"
  | "compose_service"
  | "compose_volume"
  | "compose_network"
  | "compose_port"
  | "compose_environment_variable"
  | "workflow_name"
  | "workflow_trigger"
  | "workflow_job"
  | "github_action"
  | "workflow_permission"
  | "workflow_step"
  | "workflow_environment_variable"
  | "documentation_technology_claim"
  | "unsupported_technology"
  | "documented_command";

export interface ObservationSource {
  path: string;
  locator: string;
  kind: ObservationSourceKind;
}

export interface TechnicalObservation {
  analyzer: AnalyzerId;
  category: ObservationCategory;
  name: string;
  value: string;
  attributes?: Readonly<Record<string, string>>;
  source: ObservationSource;
  claimType: ObservationClaimType;
  status: ObservationStatus;
  verificationBasis: VerificationBasis;
  confidence: ObservationConfidence;
}

export type AnalyzerIssueCode =
  | "INVALID_JSON"
  | "INVALID_XML"
  | "INVALID_YAML"
  | "INVALID_LOCKFILE"
  | "ANALYZER_FAILED";

export interface AnalyzerIssue {
  analyzer: AnalyzerId;
  code: AnalyzerIssueCode;
  path: string;
}

export interface AnalyzerInput {
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  files: readonly FilteredAnalysisFile[];
}

export interface AnalyzerOutput {
  observations: readonly TechnicalObservation[];
  issues: readonly AnalyzerIssue[];
}

export interface TechnologyAnalyzer {
  readonly id: AnalyzerId;
  analyze(input: AnalyzerInput): AnalyzerOutput;
}

export interface TechnologyAnalysisResult {
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  observations: TechnicalObservation[];
  issues: AnalyzerIssue[];
}