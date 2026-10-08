export type GitHubReadErrorCode =
  | "REPOSITORY_NOT_FOUND"
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_FAILED"
  | "RATE_LIMITED"
  | "NETWORK_FAILURE"
  | "SERVICE_UNAVAILABLE"
  | "INVALID_RESPONSE"
  | "DEFAULT_BRANCH_MISSING"
  | "DEFAULT_BRANCH_COMMIT_MISSING"
  | "TREE_RETRIEVAL_FAILED"
  | "BLOB_RETRIEVAL_FAILED"
  | "SNAPSHOT_INCONSISTENT"
  | "CREDENTIAL_CONFIGURATION_INVALID"
  | "CREDENTIAL_STORE_UNAVAILABLE";

const SAFE_MESSAGES: Record<GitHubReadErrorCode, string> = {
  REPOSITORY_NOT_FOUND: "Repository was not found or is not accessible with the configured read credentials.",
  AUTHENTICATION_FAILED: "GitHub authentication failed. Check the approved read credential configuration.",
  AUTHORIZATION_FAILED: "GitHub denied read access to the configured repository.",
  RATE_LIMITED: "GitHub rate limit prevented repository metadata access.",
  NETWORK_FAILURE: "GitHub could not be reached after the bounded read retry policy.",
  SERVICE_UNAVAILABLE: "GitHub repository metadata is temporarily unavailable.",
  INVALID_RESPONSE: "GitHub returned an invalid repository metadata response.",
  DEFAULT_BRANCH_MISSING: "GitHub repository metadata did not include a default branch.",
  DEFAULT_BRANCH_COMMIT_MISSING: "The configured default branch did not resolve to a commit.",
  TREE_RETRIEVAL_FAILED: "The repository tree could not be read from the selected snapshot.",
  BLOB_RETRIEVAL_FAILED: "A repository file could not be read from the selected snapshot.",
  SNAPSHOT_INCONSISTENT: "GitHub responses could not be bound to one repository snapshot.",
  CREDENTIAL_CONFIGURATION_INVALID: "The approved GitHub App read credential configuration is incomplete or invalid.",
  CREDENTIAL_STORE_UNAVAILABLE: "The operating-system credential store is unavailable for this local read.",
};

export class GitHubReadError extends Error {
  readonly code: GitHubReadErrorCode;
  readonly retryCount: number;

  constructor(code: GitHubReadErrorCode, retryCount = 0) {
    super(SAFE_MESSAGES[code]);
    this.name = "GitHubReadError";
    this.code = code;
    this.retryCount = retryCount;
  }
}