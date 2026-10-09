# Automated Documentation Sync

## Local setup

Requires Node.js 24 LTS.

```sh
npm ci
npm run build
npm test
npm run docs:sync -- --repository octo-org/docs --validate-only
```

`npm ci` installs the pinned local Gitleaks 8.30.1 binary from the official release and verifies its published SHA-256 checksum. The scanner runs only on filtered temporary copies, emits redacted JSON to a captured pipe, and returns sanitized path/rule/line metadata. Raw scanner output is discarded. If installation or scanning fails, the run blocks; there is no global scanner fallback.

The CLI accepts exactly one `OWNER/REPO` target, for example `octo-org/docs`. Mixed-case names are accepted and normalized to lowercase for the canonical repository identifier. URLs, whitespace, extra path segments, branch selectors, and multiple targets are rejected. The CLI first reads GitHub repository metadata and obtains the current default branch from that response; it does not assume a branch name.

Public repository metadata and files are read anonymously. The run pins one default-branch commit, collects file metadata/text under the approved resource caps, and records the root `technical-profile.md` as present or absent. Repository code is never executed. For a private repository in a local run, store an expiring fine-grained PAT with read-only metadata and contents access in the operating-system credential manager under service `automated-documentation-sync` and account equal to the lowercase `OWNER/REPO` identifier. The CLI retrieves it from the OS keychain; do not pass it as an argument or store it in repository files.

Local CLI execution has no proposal-write credential. It cannot create a branch or PR. The CLI runs the already-built project test files through Node's TAP test runner and accepts a test PASS only when the process exits successfully and the parsed test totals match the pinned suite contract. The `--validate-only` mode performs the same test execution and gate checks but never attempts proposal creation. No environment variable can assert a test PASS.

## GitHub Actions

Run **Docs Sync Foundation** with **Actions > Run workflow** and provide one `target_repository` value, such as `octo-org/docs`. A target-keyed concurrency group prevents overlapping workflow execution for the same target. The validation job builds the CLI and test files, then runs a read-only, candidate-bound gate preflight; the CLI executes the tests and verifies their actual TAP result before the gate can pass. Only on success does the proposal job start; it rebuilds and reruns collection, scanning, analysis, reconciliation, tests, and the full gate against a fresh snapshot before requesting a write token. It does not reuse the earlier candidate. Both jobs have a 15-minute ceiling; the configured overall run limit is 10 minutes, scanner limit 30 seconds, and each proposal operation is limited to 30 seconds. The approximately five-minute DEC-08 target has not been benchmarked on a representative live repository.

The workflow's built-in token has `contents: read` only and is used to check out this project. Public targets need no target read credential. For private targets, configure the approved read-only GitHub App installation on that exact repository, set the Actions variables `DOCS_SYNC_READ_APP_ID` and `DOCS_SYNC_READ_APP_INSTALLATION_ID`, and store its private key as the protected secret `DOCS_SYNC_READ_APP_PRIVATE_KEY`. The client mints a short-lived token restricted to the target with metadata and contents read permissions.

The separate proposal App is installed only on the target repository and is configured independently. Configure the protected `docs-sync-proposal` Actions environment with required reviewer protection, set `DOCS_SYNC_PROPOSAL_APP_ID` and `DOCS_SYNC_PROPOSAL_APP_INSTALLATION_ID` as environment variables, and store `DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY` as an environment secret. Set `DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED=true` only after verifying that the default branch requires human-approved PRs and the App has no bypass. The adapter requests only metadata read, contents write, and pull-requests write for the exact target. It creates a feature branch and PR for `technical-profile.md` only; it has no approve, merge, auto-merge, or default-branch-write operation. Missing or invalid proposal configuration blocks proposal creation. Write calls are single-attempt; ambiguous failures require operator inspection and a complete rerun.

Local CLI runs have read access only and cannot create proposals. A proposal timeout or ambiguous write outcome is reported without automatic retries; rerun from a fresh snapshot after inspecting any branch/PR state. Same-target Actions workflow runs share a target-keyed concurrency group; GitHub Actions permits a pending run, so this serializes executions but is not a strict fail-fast distributed lock. The in-process lock additionally fails fast within one process. No live proposal credential, branch, or PR was used to verify the adapter; automated proposal tests use a fake HTTP transport.

## Sample Target Repository

### Customer Order Management API

This sample Spring Boot application demonstrates automated technical documentation. It supports customer order processing and order status tracking.

### Application Details

- Application Name: Customer Order Management API
- Service Owner: Digital Engineering Team
- Business Impact: Supports customer order processing and order status tracking.
- Version: 1.0.0

### Technology Stack

- Language: Java
- Runtime: Java 17
- Framework: Spring Boot 3.2.5
- Build Tool: Maven
- Database: PostgreSQL
- ORM: Spring Data JPA

### Infrastructure

- Container Platform: Docker
- Cloud Provider: AWS
- Container Service: Amazon ECS

### Integrations

#### Upstream Dependencies

- Customer Identity API

#### Downstream Consumers

- Order Tracking Portal

### External APIs

- Customer Identity API

### Configuration

The application uses environment variables for runtime configuration.

Environment variable names:

- DB_HOST
- DB_PORT
- DB_NAME
- DB_USERNAME
- ORDER_SERVICE_URL

No credentials or secret values are stored in this repository.

### Testing

- Test Framework: JUnit 5
- Test Support: Spring Boot Test

### Observability

- Logging: Spring Boot application logging
- Monitoring: Not specified

### Deployment

The application is packaged as a Docker container and deployed to Amazon ECS.

### Repository

This repository contains the source and configuration used for the Customer Order Management API demonstration.
