import type { TechnicalObservation } from "../analyzers/types.js";
import type {
  EvidenceAuthority,
  EvidenceSourceType,
  ProfileField,
  ProfileSectionId,
} from "./types.js";

export interface ObservationMapping {
  sectionId: ProfileSectionId | null;
  profileField: ProfileField;
  fieldKey: string;
}

const SECTION_IDS: Readonly<Record<Exclude<ProfileField, "Unmapped">, ProfileSectionId>> = {
  "Application Name": "01",
  "Description": "02",
  "Primary Language / Runtime": "03",
  "Frameworks and Libraries": "04",
  "Dependencies": "05",
  "Database / Data Stores": "06",
  "APIs and Integrations": "07",
  "Configuration / Environment Variables": "08",
  "Build and Test": "09",
  "CI/CD": "10",
  "Deployment / Infrastructure": "11",
  "Security": "12",
  "Logging and Monitoring": "13",
  "Repository / Branch": "14",
  "Limitations / Missing Information": "15",
  "Evidence / Verification Status": "16",
};

const LANGUAGES = new Set(["java", "javascript", "typescript", "node.js", "node"]);
const DATABASES = new Set(["postgresql", "mysql", "mariadb", "sqlite", "mongodb", "redis"]);
const APIS = new Set(["openapi", "graphql"]);
const FRAMEWORKS = new Set([
  "spring", "spring boot", "react", "angular", "vue.js", "express", "nestjs", "jest", "vitest", "mocha",
]);

export function mapObservation(observation: TechnicalObservation): ObservationMapping {
  const name = observation.name.toLowerCase();
  switch (observation.category) {
    case "package_name":
    case "project_coordinate":
      return observation.category === "package_name" || name === "artifactid"
        ? mapped("Application Name", "application_name")
        : unmapped();
    case "package_description":
      return mapped("Description", "description");
    case "java_language_level":
    case "node_engine_constraint":
      return mapped("Primary Language / Runtime", `${observation.category}:${normalizeKey(observation.name)}`);
    case "dependency": {
      const resolved = observation.source.kind === "lockfile" || observation.attributes?.versionKind === "lockfile_resolved";
      return mapped("Dependencies", `dependency:${normalizeKey(observation.name)}:${resolved ? "resolved" : "declared"}`);
    }
    case "build_plugin":
    case "build_command":
    case "test_command":
    case "test_tool":
    case "maven_wrapper_version":
      return mapped("Build and Test", `${observation.category}:${normalizeKey(observation.name)}`);
    case "java_package":
      return unmapped();
    case "java_import":
    case "node_module_reference":
      return mapped("Frameworks and Libraries", `library_reference:${normalizeKey(observation.value)}`);
    case "configuration_variable":
    case "docker_environment_variable":
    case "docker_build_argument":
    case "compose_environment_variable":
    case "workflow_environment_variable":
      return mapped("Configuration / Environment Variables", `environment_variable:${normalizeKey(observation.value)}`);
    case "configuration_reference":
      return mapConfigurationReference(observation.name);
    case "docker_base_image":
    case "docker_build_stage":
    case "docker_exposed_port":
    case "docker_ignore_pattern":
    case "compose_service":
    case "compose_volume":
    case "compose_network":
    case "compose_port":
    case "infrastructure_resource":
      return mapped("Deployment / Infrastructure", `${observation.category}:${normalizeKey(observation.name)}`);
    case "workflow_name":
    case "workflow_trigger":
    case "workflow_job":
    case "github_action":
    case "workflow_permission":
    case "workflow_step":
      return mapped("CI/CD", `${observation.category}:${normalizeKey(observation.name)}`);
    case "documentation_technology_claim":
      return mapDocumentedTechnology(observation.value);
    case "unsupported_technology":
      return mapped("Limitations / Missing Information", `unsupported_technology:${normalizeKey(observation.value)}`);
    case "documented_command":
      return mapped("Build and Test", `documented_command:${normalizeKey(observation.name)}`);
    default:
      return unmapped();
  }
}

export function sourceTypeForObservation(observation: TechnicalObservation): EvidenceSourceType {
  if (observation.verificationBasis === "documentation_claim" || observation.claimType === "documentation_claim") {
    return "documentation";
  }
  if (observation.source.kind === "lockfile" || observation.verificationBasis === "lockfile_resolution") {
    return "package_lockfile";
  }
  switch (observation.analyzer) {
    case "java_maven":
      return observation.category === "maven_wrapper_version" ? "maven_wrapper" :
        observation.source.kind === "source" ? "source_pattern" : "maven_manifest";
    case "javascript_node":
      return observation.source.kind === "source" ? "source_pattern" : "package_manifest";
    case "docker":
      return observation.source.kind === "dockerfile" ? "dockerfile" : "compose_configuration";
    case "github_actions":
      return "workflow";
    case "documentation":
      return observation.source.kind === "configuration" ? "configuration" : "documentation";
  }
}

export function authorityForSource(sourceType: EvidenceSourceType): EvidenceAuthority {
  switch (sourceType) {
    case "github_metadata":
      return "github_metadata";
    case "package_lockfile":
      return "lockfile";
    case "maven_manifest":
    case "maven_wrapper":
    case "package_manifest":
    case "dockerfile":
    case "compose_configuration":
    case "workflow":
    case "configuration":
      return "manifest_configuration";
    case "source_pattern":
      return "source_code";
    case "documentation":
      return "documentation";
    case "filtering":
      return "filtering_policy";
    case "unknown":
      return "unmapped";
  }
}

export function authorityRank(authority: EvidenceAuthority): number {
  switch (authority) {
    case "github_metadata": return 100;
    case "lockfile": return 90;
    case "manifest_configuration": return 80;
    case "source_code": return 60;
    case "documentation": return 40;
    case "filtering_policy": return 30;
    case "unmapped": return 0;
  }
}

export function sectionIdFor(field: Exclude<ProfileField, "Unmapped">): ProfileSectionId {
  return SECTION_IDS[field];
}

function mapConfigurationReference(name: string): ObservationMapping {
  const key = name.toLowerCase();
  if (/(?:java|maven|node|runtime|language)/.test(key)) {
    return mapped("Primary Language / Runtime", `configuration:${normalizeKey(name)}`);
  }
  if (/(?:build|test|mvn|npm|yarn|pnpm)/.test(key)) {
    return mapped("Build and Test", `configuration:${normalizeKey(name)}`);
  }
  if (/(?:database|datasource|sql|mongo|redis)/.test(key)) {
    return mapped("Database / Data Stores", `configuration:${normalizeKey(name)}`);
  }
  if (/(?:api|graphql|openapi|endpoint)/.test(key)) {
    return mapped("APIs and Integrations", `configuration:${normalizeKey(name)}`);
  }
  if (/(?:security|auth|tls|ssl)/.test(key)) {
    return mapped("Security", `configuration:${normalizeKey(name)}`);
  }
  if (/(?:log|monitor|metric|trace)/.test(key)) {
    return mapped("Logging and Monitoring", `configuration:${normalizeKey(name)}`);
  }
  if (/(?:framework|library|spring|react|angular|vue)/.test(key)) {
    return mapped("Frameworks and Libraries", `configuration:${normalizeKey(name)}`);
  }
  return unmapped();
}

function mapDocumentedTechnology(value: string): ObservationMapping {
  const normalized = value.toLowerCase();
  if (LANGUAGES.has(normalized)) {
    return mapped("Primary Language / Runtime", `documented_technology:${normalizeKey(normalized)}`);
  }
  if (DATABASES.has(normalized)) {
    return mapped("Database / Data Stores", `documented_technology:${normalizeKey(normalized)}`);
  }
  if (APIS.has(normalized)) {
    return mapped("APIs and Integrations", `documented_technology:${normalizeKey(normalized)}`);
  }
  if (FRAMEWORKS.has(normalized)) {
    return mapped("Frameworks and Libraries", `documented_technology:${normalizeKey(normalized)}`);
  }
  if (normalized === "docker") {
    return mapped("Deployment / Infrastructure", "documented_technology:docker");
  }
  if (normalized === "github actions") {
    return mapped("CI/CD", "documented_technology:github_actions");
  }
  return unmapped();
}

function mapped(field: Exclude<ProfileField, "Unmapped">, fieldKey: string): ObservationMapping {
  return { sectionId: sectionIdFor(field), profileField: field, fieldKey };
}

function unmapped(): ObservationMapping {
  return { sectionId: null, profileField: "Unmapped", fieldKey: "unmapped" };
}

function normalizeKey(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}