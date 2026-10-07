## 1. Decision

**Status: READY FOR APPROVAL**

Recommend a Node.js LTS/TypeScript implementation with one shared command-line entry point. The initial operator trigger is a GitHub Actions `workflow_dispatch` run on a GitHub-hosted runner. The same command can be run locally for development and diagnosis. Each run receives exactly one target repository (`OWNER/REPO`) and resolves that repository's current default branch from GitHub metadata; callers cannot select a different branch.

The workflow generates and validates a proposed `technical-profile.md` change but does not push to the target's default branch or merge it. The validation/test gate must pass before any proposal or Pull Request is created. A reviewer remains responsible for approval. GitHub authentication details and PR write permissions remain separate decisions DEC-02 and DEC-03.

## 2. Options Considered

| Option | Advantages | Trade-offs | Assessment |
|---|---|---|---|
| GitHub Actions `workflow_dispatch` with a shared Node.js/TypeScript CLI | Native manual trigger and run output in GitHub; no server to operate; same command can run locally; natural place to add a later gated PR handoff. | A runner needs authorized access to the configured target, especially when it is a different private repository; workflow and runtime setup are new because this repository has no existing implementation stack. | **Recommended.** Small operational footprint and preserves a local development path. |
| Local-only CLI | Fewest hosted components; convenient for local debugging; changes remain local until a user chooses to propose them. | Requires a local runtime and repository checkout; run results and credentials depend on each developer's environment; a later PR workflow would need a separate runner/integration. | Viable fallback, but less consistent as the initial shared/manual workflow. |
| GitHub Actions-only implementation with no reusable CLI entry point | Simple operator experience in GitHub and no local runtime requirement for operators. | Makes core behavior harder to run/debug locally and couples analysis to the workflow wrapper. | Not preferred; retain one reusable command behind the workflow. |
| Always-on service, webhook receiver, or dedicated hosted application | Could support later triggers and centralized operation. | Adds hosting, credentials, availability, and operational work not required for one manual run. | Reject for the initial version as unnecessary infrastructure. |

For the runtime, Node.js LTS with TypeScript is recommended over Python because the repository has no established runtime, the capstone already centers on GitHub, and one typed command can be invoked both locally and from Actions. Python remains technically viable; no repository evidence requires either language. The exact Node.js LTS release and parser/library versions are implementation setup details.

## 3. Recommended Approach

- **Execution environment:** GitHub-hosted Actions runner for the shared operator workflow; no persistent service, database, or dedicated server.
- **Runtime/language:** Current supported Node.js LTS with TypeScript. Keep analysis, reconciliation, validation, and proposal handoff behind the shared command rather than embedding behavior in workflow YAML.
- **Manual trigger:** GitHub Actions `workflow_dispatch`, with one required `target_repository` input in `OWNER/REPO` form. The manual run reports its result in the Actions output/logs.
- **Local execution:** Expose the same command through a package script, for example `npm run docs:sync -- --repository OWNER/REPO`, for developer testing and diagnosis. This does not create a second implementation path.
- **Target/default branch:** The input identifies one repository only. The run reads GitHub metadata to discover that repository's current default branch at trigger time. Do not offer a branch override.
- **Target workspace:** Both local and Actions execution operate on a working copy/snapshot of the configured target repository, not the capstone tool's source checkout unless that is itself the target. IMP-05 materializes the target using the access/interface selected in DEC-02; the candidate stays uncommitted and unpublished until the gate and review flow allow handoff.
- **Proposal behavior:** Write the candidate/diff only in the run workspace until validation passes. No direct push or automatic merge. PR creation is enabled only after DEC-03 selects a least-privilege mechanism; a human reviewer must approve before publication.

## 4. Configuration

| Setting | Recommended source | Rule |
|---|---|---|
| Target repository | Required `workflow_dispatch` input `target_repository`; matching `--repository OWNER/REPO` option for local invocation. | Validate as a single owner/repository target. Do not accept a list or service selector. |
| Branch | GitHub repository metadata. | Resolve the target repository's current default branch on each run; no user-supplied branch override. |
| Credentials | Credential provider selected by DEC-02; PR write authorization selected by DEC-03. | Never accept tokens as workflow inputs or store credentials in source, committed configuration, or generated documentation. |
| File exclusions and source support | Approved policies/version matrix from DEC-04 and DEC-05. | Configuration must not silently broaden the approved analysis scope. |
| Runtime/test settings | Project/runtime configuration finalized during setup and DEC-07. | Keep test framework and secret-scanning tool undecided here. |

No database or persistent per-run configuration store is recommended. The target is explicit for each manual run, making the operation auditable and avoiding hidden repository selection. A configured default target can be considered later only if it does not undermine the one-repository-per-run behavior or explicit operator visibility.

## 5. Trigger Flow

1. An administrator/developer starts the workflow manually and supplies one `target_repository` value.
2. The workflow validates the target string and starts the shared Node.js/TypeScript command on a GitHub-hosted runner.
3. Using the credential mechanism selected in DEC-02, the command reads repository metadata, resolves the current default branch, and materializes that target's current state in an isolated working copy/snapshot, including `technical-profile.md` when present.
4. The command filters inputs, analyzes repository evidence, composes the candidate, and reconciles the existing profile.
5. Automated completeness/security/consistency validation and tests run. **If any required gate check fails, the run stops before review handoff or PR creation; the approved profile remains unchanged.**
6. After a passing gate, the selected DEC-03 proposal mechanism may create a reviewable change/PR. The workflow never merges it or publishes directly to the default branch.
7. The Actions output reports success, partial analysis, or failure and identifies the proposed documentation change without exposing secrets.

The same command can be invoked locally with the same repository argument. Local use is primarily for development/diagnosis; it does not bypass validation, the human-review requirement, or the approved proposal workflow.

## 6. Rationale

- The repository currently contains documentation and `.gitattributes`, but no package manifest, source tree, runtime convention, or Actions workflow. There is no established stack to preserve, so this is a greenfield recommendation rather than an assumption based on existing code.
- A manually dispatched hosted run matches the initial trigger requirement and provides a shared run result without an always-on service.
- A single reusable command supports local testing while keeping orchestration thin and preserving future trigger flexibility.
- One explicit repository input and metadata-based default-branch resolution satisfy one-repository/current-default-branch constraints without guessing branch names.
- Keeping the candidate in the run workspace until the gate passes protects the approved profile. A separate proposal step supports human review and a future PR workflow.
- Node.js LTS/TypeScript is a practical cross-platform runtime for a small CLI and GitHub workflow. This choice does not select GitHub API libraries, source parsers, test framework, or secret scanner.

## 7. Trade-offs

- The GitHub-hosted runner depends on GitHub availability and workflow permissions. Local invocation remains available for debugging, but is not the canonical shared run output.
- A workflow in this capstone repository may target another repository. Reading a private target therefore requires credentials authorized for that target; DEC-02 must decide that provider and scope. Do not assume the workflow repository's default token can access another private repository.
- Creating a PR generally needs permissions beyond read access. DEC-03 must select a separate least-privilege write/handoff mechanism; this decision does not grant those permissions.
- A required repository input is explicit but requires the operator to supply the target for each run. A stored default could reduce repetition but risks obscuring which repository is analyzed.
- TypeScript introduces project/build setup in a repository with no current runtime. Python could also implement the CLI; the recommendation favors TypeScript for a shared Node/GitHub workflow, not because the current repository already uses it.
- GitHub Actions is the initial shared trigger, while the exact reusable packaging, Node.js version pin, and workflow implementation belong to later setup tasks. No automatic schedule, repository-change trigger, direct push, or auto-merge is included.

## 8. Impact on Implementation Tasks

- **DEC-01:** Ready to close on approval with GitHub-hosted `workflow_dispatch` as the shared manual trigger, a Node.js LTS/TypeScript command as the implementation runtime, and a required `OWNER/REPO` input. The same command remains locally runnable.
- **IMP-01:** Establish the Node.js/TypeScript project and a local command entry point after this decision is approved; test framework remains gated by DEC-07.
- **IMP-02 / IMP-03:** Implement one-repository input validation, metadata-based default-branch lookup, and manual workflow invocation. No branch override is exposed.
- **IMP-04 / IMP-05:** The Actions runner and local command use the credential provider/API chosen by DEC-02 to access the selected public/private target, materialize its current default-branch state separately from the tool checkout, and read its existing profile. These tasks remain blocked until DEC-02 is resolved.
- **IMP-13 / IMP-14:** The shared command must enforce the gate before proposal handoff. PR creation and write permissions are not decided here and remain blocked by DEC-03.
- **IMP-15 / IMP-16 / IMP-17:** Report run outcomes through Actions output, retain local invocation for diagnosis, and verify the selected runner/runtime against the approved performance and operational decisions in DEC-08.

DEC-01 does not resolve authentication/credential provider (DEC-02), PR creation permissions (DEC-03), source/parser versions and evidence/template details (DEC-05), reconciliation mechanics (DEC-06), test framework/gate tooling (DEC-07), or operational/performance thresholds (DEC-08).