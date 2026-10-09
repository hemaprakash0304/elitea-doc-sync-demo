## 1. Decision

**Recommended mechanism:** Use a dedicated proposal GitHub App, separate from the DEC-02 read-only App, to create a feature branch and Pull Request through the GitHub REST API. The proposal App is installed only on the configured target repository and has only the permissions required to write the proposed branch and open a PR. Its credential is available only to a proposal job that runs after the complete validation/test gate succeeds.

The workflow may create a branch and PR after the gate passes. It may not write directly to the default branch, approve its own PR, merge, or enable auto-merge. Protect the target's default branch with a ruleset requiring a PR and human approval and giving the proposal App no bypass. DEC-02 read credentials remain read-only and are never reused for writes.

## 2. Options Considered

| Option | Advantages | Risks/limitations | Assessment |
|---|---|---|---|
| Dedicated GitHub App plus GitHub REST API | Short-lived token; distinct read/write identities; explicit repository permission scopes; suitable when target differs from the workflow repository. | Requires a second App installation/key and repository ruleset setup. GitHub App contents permission is repository-scoped, not branch-scoped, so default-branch protection is essential. | **Recommended.** Strongest practical separation with a simple API-based proposal flow. |
| Elevate the DEC-02 read App and mint a write token from it | Fewer App registrations. | Couples analysis and write authority to one identity; an installation/private-key compromise gains write capability; violates the intended separation of read and write credentials. | Reject. Do not upgrade or reuse the read-only App for writes. |
| Fine-grained PAT for branch/PR creation | Can be restricted to a repository and permissions. | Long-lived user credential in automation, tied to a human identity and harder to govern/rotate safely than a short-lived App token. | Not preferred for unattended proposal creation; fallback only with explicit security approval. |
| `GITHUB_TOKEN` | Short-lived and easy to scope for a workflow in its own repository. | Limited to the repository hosting the workflow; cannot support the general cross-repository target model. | Use only for workflow-repository operations, not as the target PR credential. |
| GitHub CLI (`gh pr create`) | Convenient user-facing command and PR formatting. | Does not improve authorization; still needs a write credential and may rely on a developer's broader local `gh` session. Adds a CLI dependency to the runner. | Not selected. REST API provides a direct, auditable flow with the App token. |
| Fork-based PR | Avoids writing branches to the upstream repository in some contribution models. | Adds a second repository and credential boundary; private-repository forks may be prohibited or expose private source; complicates the one-target workflow. | Reject for the initial capstone. Use a same-repository feature branch. |
| Direct push to default branch or automatic merge | Fastest apparent path. | Bypasses review and conflicts with the approved architecture and requirements. | Prohibited. |

## 3. Recommended PR Mechanism

After validation passes, a dedicated proposal GitHub App obtains a short-lived installation token for the exact configured target. The proposal job uses the GitHub REST API to:

1. Read the target's current default branch and its current tip.
2. Create a new, run-specific branch based on that default-branch tip.
3. Commit only the reconciled `technical-profile.md` change to the new branch.
4. Open a Pull Request from that branch to the default branch, with a concise run summary and validation result.

The PR must show the reconciled additions, modifications, and removals. It must not include source files, credentials, secret values, or unrelated changes. If the profile is unchanged, do not create an empty PR. The proposal App is not the DEC-02 read App; its private key and installation token are separate credentials.

## 4. Branch and PR Flow

1. A read-only analysis/validation job reads the selected target and produces the reconciled candidate.
2. The complete automated validation and test gate runs. Until it succeeds, no proposal credential is made available and no branch or PR is created.
3. A separate proposal job starts only on successful completion of that gate. It receives the proposal App credential from a protected Actions secret/environment and mints a short-lived token restricted to the target repository.
4. The job creates a run-specific feature branch from the current default-branch tip and commits only `technical-profile.md` to that branch.
5. The job opens a PR targeting the default branch. It does not update the default branch, approve the PR, or merge it.
6. A developer/designated reviewer reviews and approves the diff. Publication occurs only through the repository's protected PR merge process.

For local CLI use, DEC-02's read-only PAT remains read-only. Local use may prepare and validate a candidate/diff, but PR/write capability is not granted by this decision. The Actions proposal App is the initial automated write path.

## 5. Permission Scope

Minimum target-repository GitHub App permissions for proposal creation:

| Permission | Level | Purpose |
|---|---|---|
| Metadata | Read-only | Identify the repository and default branch; required by GitHub for repository access. |
| Contents | Write | Create a feature branch and commit the single proposed Markdown file to that branch. This permission can write repository contents, so default-branch ruleset protection is mandatory. |
| Pull requests | Write | Create the review Pull Request. It does not authorize approval or merge. |

No administration, Actions/workflow management, checks/status writing, organization access, or merge permission is requested. Do not grant `contents: write` or `pull_requests: write` to the DEC-02 read identity. `GITHUB_TOKEN` remains limited to the workflow repository and is not used for cross-repository proposal writes.

The target repository's default branch must have a ruleset/branch protection policy that requires changes through a PR, blocks direct updates and force pushes, requires at least one human approval, and does not list the proposal App as a bypass actor. GitHub permissions are repository-scoped rather than branch-scoped; the ruleset is therefore a required control, not an optional safeguard.

## 6. Validation Gate Enforcement

- Run the full required-field, template/order, evidence-status, conflict, sensitive-value, failure-preservation, repeatability, and automated-test checks before starting the proposal job.
- Make the proposal job depend on the successful validation/test job and run it only when that job succeeds. Gate failure, cancellation, skipped checks, or missing validation output must fail closed.
- Keep the proposal App private key out of the read/analysis/validation job. Store it in a protected Actions secret/environment referenced only by the post-gate proposal job.
- The proposal job must revalidate that the target matches the configured/installed target and must not accept a token or target from untrusted workflow input without validation.
- A validation failure must not create a branch or PR. It reports the failed checks and leaves the approved profile unchanged.

## 7. Human Review and Merge

- The PR is the review boundary; it is not publication by itself.
- Configure the target default branch to require a PR and at least one approval from a developer/designated reviewer before merge.
- Do not grant the proposal App ruleset bypass, approve its own PR, merge, or enable auto-merge.
- Reviewers must be able to inspect the exact generated `technical-profile.md` diff, including removals and preserved/flagged manual content.
- Failed checks, missing approvals, or merge conflicts leave the approved default-branch profile unchanged until a human resolves them through the normal review process.

## 8. Credential and Secret Handling

- Keep the proposal App private key separate from the DEC-02 read App key and store it as a protected GitHub Actions secret/environment secret. Do not store it in source, committed configuration, workflow inputs, or artifacts.
- Mint the installation token only in the post-gate proposal job, restrict it to the one target repository and the App's minimum granted permissions, mask it immediately, and discard it after the job.
- Do not print tokens, authorization headers, raw API error bodies, shell environments, or token-bearing URLs. Disable shell tracing during secret handling and sanitize diagnostics.
- Do not put credentials or secret values in the branch name, commit message, PR title/body, generated profile, or logs. Environment-variable values remain excluded.
- Keep the DEC-02 read token read-only. A read token is never promoted, reused, or passed into the proposal job as write authorization.

## 9. Failure and Recovery Behavior

- **Validation/test failure or cancellation:** Proposal job does not run; no write credential is issued, no branch/PR is created, and the approved profile is unchanged. Report failure and rerun after correction.
- **Write credential or permission failure:** Do not fall back to DEC-02 credentials, a developer's broad `gh` session, or direct default-branch writes. Report the access failure; approved documentation remains unchanged.
- **Branch creation failure:** Do not attempt an alternate default-branch write. Report the failure and leave the approved profile unchanged.
- **Commit or PR creation failure:** Report that proposal handoff failed. The default branch remains unchanged; if a temporary branch was created, it contains only the proposed profile change and may be cleaned up only through an explicitly authorized safe cleanup path.
- **Human review rejection or requested changes:** Keep the approved profile unchanged until a reviewer approves and merges an updated proposal.
- **Retry:** Re-run analysis and the full gate against the current default-branch state before creating a new proposal; do not reuse stale validated output without revalidation.

## 10. Security Risks and Mitigations

- **Proposal App can write repository contents:** Repository-level `Contents: write` is broader than one branch. Require a default-branch ruleset with no App bypass, and have code create commits only on a generated feature branch.
- **Write credential exposed before validation:** Isolate it in a post-gate job and secret environment; make that job depend on a successful complete gate and fail closed on skipped/unknown results.
- **Cross-target credential misuse:** Install the proposal App only on the configured target, restrict the installation token to that exact repository, validate the target, and fail closed on mismatch.
- **Credential leakage:** Keep read/write keys separate, mask short-lived tokens, avoid command-line/environment dumps, and sanitize PR metadata and errors.
- **Unreviewed publication:** Require human PR approval and protected-branch merge; disable App bypass, auto-approval, and auto-merge.
- **Alternative paths bypass controls:** Do not use `gh` with a developer's broad session, fork credentials, or a fallback push when the REST/App flow fails.
- **Organization policy or ruleset unavailable:** Do not enable automated writes until the target's protection controls and App installation are approved; continue read-only/local proposal generation if permitted.

## 11. Impact on Implementation Tasks

- **DEC-03:** This decision recommends a dedicated proposal GitHub App and REST API branch/PR flow, with a protected default branch and human approval.
- **IMP-13:** The complete validation/test gate becomes a strict predecessor of the write job; failed, skipped, or cancelled gate means no write credential, branch, or PR.
- **IMP-14:** Implement branch creation and PR creation using the proposal App after gate success. Commit only the reconciled `technical-profile.md` change; do not merge.
- **IMP-15:** Report branch/PR success or failure without exposing credentials or private response content.
- **IMP-16 / IMP-17:** Configure and verify the target ruleset, exact-target App installation, separate secrets, no-bypass behavior, required approval, and failure-safe recovery.
- **DEC-02 remains unchanged:** Its read-only App/PAT path is used for collection only and is never reused for proposal writes.

## 12. DEC-03 Status

**READY FOR APPROVAL.** The recommended write mechanism is a dedicated target-scoped GitHub App using the REST API. Minimum permissions are Metadata read, Contents write, and Pull requests write. It may create a feature branch and PR only after the full validation/test gate passes; it may not merge. Direct default-branch writes are blocked by a required no-bypass branch ruleset, and human approval is mandatory.

DEC-02 read-only credentials remain separate. No automatic merge, direct default-branch push, or publication without human approval is approved.