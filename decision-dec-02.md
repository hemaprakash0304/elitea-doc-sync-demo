## 1. Decision

**Recommended mechanism:** Use GitHub REST API for repository metadata and content. For a private target in GitHub Actions, use a short-lived GitHub App installation token restricted to the single configured target repository with read-only repository permissions. For local private-repository runs, use a user-owned, expiring fine-grained PAT restricted to that same target repository and the same read-only permissions. Public repositories should be read anonymously by default.

The credential source differs between Actions and local runs, but the authorization policy is the same: one target repository, metadata read, contents read, and no write permission. Never accept tokens as workflow inputs or store them in source or committed configuration. PR/write authorization remains explicitly reserved for DEC-03.

## 2. Options Considered

| Option | Advantages | Risks/limitations | Assessment |
|---|---|---|---|
| GitHub App installation token in Actions | Short-lived; permissions can be read-only; suitable for cross-repository access; token can be restricted to the selected installed repository. | Requires App registration/installation and secure private-key handling. The App must be installed only on the configured private target; changing that target requires administrator-approved installation changes. | **Recommended for Actions private-repository access.** |
| Fine-grained PAT in Actions | Straightforward; can be restricted to one repository and read-only contents. | Long-lived user credential stored by automation; rotation and ownership lifecycle; less suitable than an App identity for unattended runs. | Fallback only if organizational policy prevents an App and security owners approve it. |
| `GITHUB_TOKEN` for target access | Automatically issued and short-lived; appropriate for operations in the repository hosting the workflow. | Scoped to the workflow repository, so it cannot reliably read a different private target repository. | Use only for the capstone/workflow repository's own checkout with explicit read permissions, not as the general target credential. |
| Classic PAT | Familiar and can access repositories. | Broad scopes, longer-lived credential, poor fit for least privilege. | Do not use. |
| Fine-grained PAT for local private-repository access | User-owned, can be restricted to one target repository and read-only permissions; practical for local CLI use. | Long-lived until expiration/revocation and tied to a developer identity; must be protected in a local credential store. | **Recommended local mechanism**, with expiration and local secure storage. |
| GitHub App private key on developer machines | Consistent App identity across environments. | Distributes a powerful App private key to developers and increases compromise impact. | Do not distribute the App private key locally. |
| Anonymous access for public repositories | No credential or secret exposure; simplest read path. | Subject to unauthenticated API rate limits. | **Recommended for public-repository reads** unless rate limits or policy require authenticated access. |

## 3. Recommended Authentication Model

Use the GitHub REST API for the target repository's metadata and content. The run obtains repository metadata to resolve the current default branch, then reads the file tree/content needed for analysis, including the existing `technical-profile.md`. GraphQL, repository write access, and a broad clone credential are not required by DEC-02.

Authentication is selected by execution context:

- **Actions, private target:** A GitHub App installed only on the configured private target repository. The workflow exchanges its App credentials for a short-lived installation token and restricts that token to the exact target repository and read-only permissions. Validate the requested `OWNER/REPO` against the configured/installed target and fail closed on mismatch.
- **Local CLI, private target:** A fine-grained PAT created by the developer for only the selected target repository, with read-only metadata/content access and an expiration set according to the shortest practical organizational policy. Retrieve it from an OS credential manager or approved local credential store, not from source, committed configuration, command-line arguments, or a workflow input.
- **Public target:** Read anonymously by default. Do not request or expose credentials merely to read public content.

This is the same least-privilege authorization model in both environments, not the same credential. The local credential represents the developer; the Actions credential represents the installed App. Neither read credential can create a PR or write repository content.

## 4. GitHub Actions Authentication

- Use the GitHub App installation token for private target-repository access. Store the App private key as a protected GitHub Actions secret in the capstone workflow repository; keep App installation limited to the configured target repository, not the whole organization.
- Mint a short-lived token for each run, restricted to the selected repository and read-only permissions. Do not persist it or write it to an artifact/cache.
- Give the workflow's built-in `GITHUB_TOKEN` only the permissions needed to check out the capstone/tool repository, such as `contents: read`. Do not treat it as authorization for a distinct target repository.
- For public targets, use unauthenticated REST reads unless a documented rate-limit need justifies authenticated access.
- If the App cannot be registered or installed under organization policy, stop and obtain approval for a narrowly scoped fallback; do not silently substitute a classic PAT or broaden `GITHUB_TOKEN`.

## 5. Local CLI Authentication

For public repositories, the local CLI reads anonymously. For private repositories, the developer uses an expiring fine-grained PAT restricted to the one target repository with the same metadata/content read permissions as the Actions App token.

Store the PAT in an OS credential manager or an approved local secure credential store. The CLI should retrieve it at runtime without displaying it. Do not pass it in process arguments, repository configuration, shell history, checked-in `.env` files, logs, generated documentation, or test fixtures. Local PAT expiration/revocation is managed by the developer and repository owner. Do not copy the Actions App private key to a developer machine.

## 6. Permission Scope

| Operation | DEC-02 permission |
|---|---|
| Read repository identity, visibility, and default-branch metadata | Repository metadata: read-only. |
| Read repository tree and file contents, including README/configuration/manifests/workflows and existing `technical-profile.md` | Repository contents: read-only. |
| Read a public repository | No credential by default; anonymous read. |
| Analyze a private repository | App installation token in Actions or one-repository fine-grained PAT locally, both read-only. |
| Create a branch, commit, or Pull Request | **Not granted by DEC-02. Reserved for DEC-03.** |
| Merge, push to default branch, change repository settings, manage Actions, or administer the repository | **Not granted.** Not required for analysis. |

No `contents: write`, `pull_requests: write`, administration, workflow-management, or organization-wide access is granted for DEC-02. GitHub App metadata access is read-only; the required metadata permission must not be expanded beyond GitHub's minimum API requirements.

## 7. Public Repository Handling

Use unauthenticated GitHub REST reads for public repository metadata and content, including default-branch discovery and files. If rate limits prevent a run, report that clearly and do not retry using a broader credential automatically. Any authenticated fallback must be explicitly authorized and restricted to the same target repository. Public read access does not grant or imply permission to propose or publish changes.

## 8. Private Repository Handling

For Actions, require an approved GitHub App installation on the configured private target. Restrict the installation and minted token to that repository; reject a target mismatch rather than querying another repository. For local use, require the developer's fine-grained PAT to select only the target repository and grant read-only metadata/contents access.

If credentials lack access, the run reports an authentication/authorization failure, creates no candidate proposal, and leaves the approved profile unchanged. Access is never broadened automatically to make a run succeed. A target change requires the designated administrator to update the target authorization deliberately.

## 9. Secret Handling and Logging

- Never accept an App key, PAT, or token as a `workflow_dispatch` input or repository command argument.
- Keep the App private key in GitHub Actions secrets and the local PAT in the developer's OS/approved credential store. Do not commit either credential or place it in source/configuration files.
- Mask the short-lived Actions token immediately after creation; do not echo credentials, request headers, environment dumps, or raw authentication/API error bodies. Disable shell tracing around credential use and redact any diagnostics that could contain sensitive values.
- Do not persist tokens in caches, artifacts, generated files, or run output. Never place credentials or secret values in `technical-profile.md`.
- Document environment-variable names only, never values. Exclude sensitive files and run the approved output validation before any proposal handoff.
- Treat access-denied errors as safe, actionable status messages; do not print token-bearing URLs or response details that may reveal private repository content.

## 10. Security Risks and Mitigations

- **App private-key compromise:** A stolen key could mint tokens for repositories where the App is installed. Install the App only on the configured target, grant read-only permissions, protect/rotate the key under organizational policy, and scope each token to the exact target.
- **Cross-repository target confusion:** A workflow input could request another repository. Validate `OWNER/REPO` against the configured target and token scope; fail closed on mismatch.
- **Long-lived local PAT exposure:** Restrict it to one repo and read-only access, require expiration, use local secure storage, and avoid logging or command-line injection.
- **Incorrect reliance on `GITHUB_TOKEN`:** It is scoped to the workflow repository. Do not use it to access a distinct private target or work around access denial.
- **Token leakage through logs or diagnostics:** Never print credentials or raw authorization responses; mask Actions tokens and sanitize local/Actions errors.
- **Overprivileged future PR workflow:** Read access remains read-only. DEC-03 must separately decide any narrowly scoped write credential/permission and ensure it is used only after the validation/test gate passes. No auto-merge or default-branch write is authorized here.
- **Organizational policy blocks an App or fine-grained PAT:** Pause the affected access path and obtain security-owner approval for an alternative with equivalent target restriction and read-only permissions; do not expand scope as a workaround.

## 11. Impact on Implementation Tasks

- **DEC-02:** This record recommends GitHub REST API, public anonymous reads, an exact-target read-only GitHub App installation token for private Actions runs, and a target-scoped fine-grained PAT stored locally for private local runs.
- **IMP-04:** Implement the two credential acquisition paths with the same read-only permission policy; keep the capstone repository's `GITHUB_TOKEN` limited to its own checkout.
- **IMP-05:** Use REST metadata to discover the target's current default branch and REST tree/content reads for the selected target; include the existing profile. Fail closed if target/auth scopes do not match.
- **IMP-15 / IMP-16:** Report authentication/access failures safely and document App installation/local PAT setup without recording credential values.
- **IMP-14 / DEC-03:** No write permissions or PR credential are included here. PR creation remains blocked until DEC-03 selects and approves the separate least-privilege proposal mechanism; the read token cannot be reused for writes.

## 12. DEC-02 Status

**READY FOR APPROVAL.** The recommended read model covers metadata, default-branch lookup, and file access for one public or authorized private target while preserving least privilege. Before implementation, confirm that organizational policy permits the single-target GitHub App installation for Actions and expiring fine-grained PATs for local developers. If either is prohibited, obtain security-owner approval for an equivalent or stricter read-only alternative; do not default to a classic PAT or expanded token scope.

DEC-03 remains open for any write/PR authorization. No write permission, PR creation, automatic publication, or merge is approved by this decision.