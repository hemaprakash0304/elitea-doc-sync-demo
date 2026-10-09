import type {
  ObservationConfidence,
  ObservationStatus,
  VerificationBasis,
} from "../analyzers/types.js";

export type ProfileSectionId =
  | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08"
  | "09" | "10" | "11" | "12" | "13" | "14" | "15" | "16";

export type ProfileField =
  | "Application Name"
  | "Description"
  | "Primary Language / Runtime"
  | "Frameworks and Libraries"
  | "Dependencies"
  | "Database / Data Stores"
  | "APIs and Integrations"
  | "Configuration / Environment Variables"
  | "Build and Test"
  | "CI/CD"
  | "Deployment / Infrastructure"
  | "Security"
  | "Logging and Monitoring"
  | "Repository / Branch"
  | "Limitations / Missing Information"
  | "Evidence / Verification Status"
  | "Unmapped";

export interface ProfileSection {
  id: ProfileSectionId;
  field: Exclude<ProfileField, "Unmapped">;
}

export const PROFILE_SECTIONS: readonly ProfileSection[] = Object.freeze([
  { id: "01", field: "Application Name" },
  { id: "02", field: "Description" },
  { id: "03", field: "Primary Language / Runtime" },
  { id: "04", field: "Frameworks and Libraries" },
  { id: "05", field: "Dependencies" },
  { id: "06", field: "Database / Data Stores" },
  { id: "07", field: "APIs and Integrations" },
  { id: "08", field: "Configuration / Environment Variables" },
  { id: "09", field: "Build and Test" },
  { id: "10", field: "CI/CD" },
  { id: "11", field: "Deployment / Infrastructure" },
  { id: "12", field: "Security" },
  { id: "13", field: "Logging and Monitoring" },
  { id: "14", field: "Repository / Branch" },
  { id: "15", field: "Limitations / Missing Information" },
  { id: "16", field: "Evidence / Verification Status" },
]);

export type EvidenceSourceType =
  | "github_metadata"
  | "maven_manifest"
  | "maven_wrapper"
  | "package_manifest"
  | "package_lockfile"
  | "source_pattern"
  | "dockerfile"
  | "compose_configuration"
  | "workflow"
  | "configuration"
  | "documentation"
  | "filtering"
  | "unknown";

export type EvidenceAuthority =
  | "github_metadata"
  | "lockfile"
  | "manifest_configuration"
  | "source_code"
  | "documentation"
  | "filtering_policy"
  | "unmapped";

export type AuthorityRelation =
  | "authoritative"
  | "supporting"
  | "overridden_by_authority"
  | "peer_conflict"
  | "unmapped";

export interface EvidenceFact {
  name: string;
  value: string;
  attributes?: Readonly<Record<string, string>>;
}

export interface EvidenceItem {
  evidenceId: string;
  sectionId: ProfileSectionId | null;
  profileField: ProfileField;
  fieldKey: string;
  sourceType: EvidenceSourceType;
  sourceLocator: string;
  fact: EvidenceFact;
  status: ObservationStatus;
  verificationBasis: VerificationBasis | "github_repository_metadata" | "filtering_policy";
  confidence: ObservationConfidence;
  authority: EvidenceAuthority;
  authorityRelation: AuthorityRelation;
  conflictsWith: string[];
}

export type CoverageStatus =
  | "supported_by_verified_evidence"
  | "supported_by_conflicting_evidence"
  | "not_specified"
  | "unable_to_verify";

export type CoverageIssueCode =
  | "EXCLUDED_SOURCE"
  | "SENSITIVE_SOURCE_EXCLUDED"
  | "UNREADABLE_SOURCE"
  | "SOURCE_LIMIT_EXCEEDED"
  | "ANALYZER_INPUT_INVALID"
  | "ANALYZER_FAILED"
  | "UNMAPPED_OBSERVATION"
  | "SCAN_COVERAGE_INCOMPLETE";

export interface CoverageIssue {
  code: CoverageIssueCode;
  count: number;
}

export interface CoverageEntry {
  sectionId: ProfileSectionId;
  profileField: Exclude<ProfileField, "Unmapped">;
  status: CoverageStatus;
  evidenceIds: string[];
  verifiedEvidenceIds: string[];
  conflictingEvidenceIds: string[];
  unverifiableEvidenceIds: string[];
  issues: CoverageIssue[];
}

export type CatalogIssueCode =
  | "SNAPSHOT_MISMATCH"
  | "MALFORMED_OBSERVATION"
  | "SENSITIVE_OBSERVATION_DROPPED"
  | "ANALYZER_ISSUE";

export interface CatalogIssue {
  code: CatalogIssueCode;
  analyzer?: string;
  path?: string;
}

export interface EvidenceCatalogResult {
  repositoryId: string;
  defaultBranch: string;
  snapshotCommitSha: string;
  evidence: EvidenceItem[];
  coverage: CoverageEntry[];
  issues: CatalogIssue[];
}