## 1. Implementation Overview

This plan implements the approved single-repository, manual-trigger documentation workflow. Work proceeds from Open Decision closure through project setup, repository access and analysis, evidence-backed profile generation, reconciliation, validation, gated change proposal, and end-to-end verification.

No implementation begins by assuming an unresolved technology choice. Decision tasks below record outcomes before dependent implementation tasks start. `technical-profile.md` is treated as an input when present. The automated validation/test gate is a hard prerequisite to handing a documentation change to a human reviewer or creating a Pull Request.

## 2. Workstreams

| Workstream | Tasks | Outcome |
|---|---|---|
| Decision closure | DEC-01 through DEC-08 | Resolve implementation-blocking Open Decisions and record decisions. |
| Project foundation and invocation | IMP-01 through IMP-03 | Establish the selected project/runtime, repository configuration, and manual trigger. |
| GitHub access and safe collection | IMP-04 through IMP-06 | Read the authorized repository/default branch, existing profile, and filtered files safely. |
| Analysis and profile generation | IMP-07 through IMP-10 | Extract evidence, build the coverage catalog, compose the required profile, and reconcile existing/manual content. |
| Validation and test gate | IMP-11 through IMP-13 | Validate completeness/security/consistency and prevent unvalidated proposal handoff. |
| Review workflow and operations | IMP-14 through IMP-16 | Propose a gated change, report run outcomes, and deploy/run within the selected environment. |
| Acceptance verification | IMP-17 | Verify the complete workflow, failure safety, security, repeatability, and performance target. |

## 3. Dependency-Ordered Implementation Tasks

### Decision tasks

#### DEC-01 — Decide execution environment, runtime, configuration, and trigger

- **Description:** Select the authorized execution environment and implementation runtime, how the single repository is configured, and the manual trigger interface. Keep future scheduled/event triggers out of initial scope.
- **Dependencies:** Approved requirements and architecture.
- **Expected output/artifact:** Decision record for execution/hosting, runtime, configuration location, and manual trigger interface.
- **Acceptance criteria:** The record names the chosen options, their operational/security boundaries, and how a user manually starts one run.
- **Blocked by an Open Decision?** No. This task resolves these Open Decisions.

#### DEC-02 — Decide GitHub API and read authentication

- **Description:** Select the GitHub API/interface, authentication type and credential provider, minimum repository-content/metadata permissions, and default-branch/snapshot behavior for a run.
- **Dependencies:** DEC-01.
- **Expected output/artifact:** GitHub access decision record, including public/private repository handling and branch-state semantics.
- **Acceptance criteria:** Read access is least-privilege, private-repository support is covered, and the current default branch is resolved without assuming its name.
- **Blocked by an Open Decision?** No. This task resolves these Open Decisions.

#### DEC-03 — Decide change proposal and Pull Request permissions

- **Description:** Select how the workflow creates a reviewable change and, if using a Pull Request, what narrowly scoped write authorization or handoff it needs. Keep human approval mandatory.
- **Dependencies:** DEC-02.
- **Expected output/artifact:** Proposal/PR workflow and permission decision record.
- **Acceptance criteria:** The chosen flow does not write unreviewed documentation to the default branch and documents the required permissions separately from repository read access.
- **Blocked by an Open Decision?** No. This task resolves the PR mechanism/permissions Open Decision.

#### DEC-04 — Decide file exclusions, secret scanning, and processing boundary

- **Description:** Define excluded/generated/binary/sensitive file patterns, secret detection/redaction approach, environment-variable value handling, and authorized processing boundary for repository content.
- **Dependencies:** DEC-01 and DEC-02.
- **Expected output/artifact:** Approved file-handling/security policy and selected secret-scanning approach.
- **Acceptance criteria:** The policy prevents prohibited values from entering generated documentation and defines how private content, intermediate processing, and diagnostics stay within the authorized workflow.
- **Blocked by an Open Decision?** No. This task resolves these Open Decisions; the specific scanner is not assumed beforehand.

#### DEC-05 — Decide analyzer support, evidence references, and profile template

- **Description:** Set supported language/runtime/framework/package-manager versions and parser coverage for Java/Maven, JavaScript/Node.js, Docker, and GitHub Actions. Define how evidence is referenced and finalize the template using the architecture's ordered FR-12 field map.
- **Dependencies:** Approved architecture field map.
- **Expected output/artifact:** Supported-source matrix, evidence-reference convention, and versioned `technical-profile.md` template.
- **Acceptance criteria:** All 16 FR-12 topics map to required fields in consistent order; the template defines how `Not Specified`, `Unable to Verify`, and conflicts are represented.
- **Blocked by an Open Decision?** No. This task resolves these Open Decisions.

#### DEC-06 — Decide existing-profile reconciliation behavior

- **Description:** Specify how generated versus manually maintained content is identified and what constitutes safe reconciliation, while retaining the approved preserve-and-flag behavior.
- **Dependencies:** DEC-05.
- **Expected output/artifact:** Reconciliation rules for existing profiles and manually maintained sections.
- **Acceptance criteria:** Rules require reading the existing profile before generating a replacement, show additions/modifications/removals in the proposed diff, preserve content that cannot safely be reconciled, and prohibit silent deletion.
- **Blocked by an Open Decision?** No. This task resolves the reconciliation-mechanism Open Decision without changing the approved behavior.

#### DEC-07 — Decide automated testing and gate execution

- **Description:** Select the test framework and define which automated validations/tests execute before a proposal can be handed off. Include coverage, security, failure-preservation, and repeatability checks.
- **Dependencies:** DEC-01 and DEC-04.
- **Expected output/artifact:** Test strategy and gate contract; no specific framework is prescribed by this plan.
- **Acceptance criteria:** The gate's pass/fail conditions and location in the run are explicit, and it blocks both human-review handoff and PR creation on failure.
- **Blocked by an Open Decision?** No. This task resolves the testing-tool Open Decision while preserving the required gate behavior.

#### DEC-08 — Decide performance and operational thresholds

- **Description:** Define a representative small-to-medium repository, how the approximately five-minute target is measured, and the initial retry, timeout, concurrency, run-state retention, and diagnostic policies. Define how repository state is treated if the default branch changes during a run.
- **Dependencies:** DEC-01 and DEC-02.
- **Expected output/artifact:** Performance benchmark profile and operational behavior decision record.
- **Acceptance criteria:** The target has a reproducible measurement method; failure/retry/diagnostic behavior preserves approved content and does not expose secrets.
- **Blocked by an Open Decision?** No. This task resolves the listed operational Open Decisions.

### Implementation tasks

#### IMP-01 — Establish project and repository setup

- **Description:** Create the selected application/project structure, dependency management, base automation, and development/test conventions. Do not add product functionality in this task.
- **Dependencies:** DEC-01 and DEC-07.
- **Expected output/artifact:** Project skeleton and documented build/test entry points.
- **Acceptance criteria:** The selected runtime builds; the test runner executes an initial passing test; credentials are absent from source/configuration defaults.
- **Blocked by an Open Decision?** Yes, until runtime/execution (DEC-01) and test framework (DEC-07) are selected.

#### IMP-02 — Implement repository configuration and targeting

- **Description:** Load the one configured GitHub repository using the selected configuration mechanism; validate its identity and resolve its default branch through repository metadata.
- **Dependencies:** IMP-01 and DEC-01.
- **Expected output/artifact:** Repository configuration model and target/default-branch resolver.
- **Acceptance criteria:** Invalid/missing targets fail clearly; a configured target is one repository; branch selection uses GitHub's default-branch metadata.
- **Blocked by an Open Decision?** Yes, until configuration storage and runtime are decided in DEC-01.

#### IMP-03 — Implement manual run trigger and coordinator

- **Description:** Provide the selected manual invocation and coordinate one run through the pipeline, returning success, partial completion, or failure without publishing documentation.
- **Dependencies:** IMP-02 and DEC-01.
- **Expected output/artifact:** Manual trigger and run coordinator.
- **Acceptance criteria:** A designated user can initiate one run; the coordinator passes a run result to reporting and has no direct default-branch publication path.
- **Blocked by an Open Decision?** Yes, until the trigger interface and execution environment are selected in DEC-01.

#### IMP-04 — Implement GitHub authentication and read access

- **Description:** Implement the selected GitHub client/authentication approach for repository metadata and contents, including authorized private-repository reads.
- **Dependencies:** IMP-01, IMP-02, DEC-02.
- **Expected output/artifact:** GitHub read adapter and credential integration.
- **Acceptance criteria:** Access uses the decided minimum scopes; missing, invalid, and insufficient credentials produce clear failures; no secret is stored in source code or profile output.
- **Blocked by an Open Decision?** Yes, until API/interface, auth type, provider, and minimum scopes are selected in DEC-02.

#### IMP-05 — Implement repository collection and profile input

- **Description:** Collect repository metadata and relevant default-branch files, including README/source/configuration files, dependency manifests, Dockerfiles, GitHub Actions workflows, and `technical-profile.md` when it exists. Capture a consistent source state according to the decision record.
- **Dependencies:** IMP-02, IMP-04, DEC-05, DEC-08.
- **Expected output/artifact:** Repository collector and collected-source representation, including existing approved profile when present.
- **Acceptance criteria:** Collection handles public/private access through the adapter, does not assume `main`, reads the existing profile before candidate generation, and reports inaccessible or incomplete reads without generating a misleading profile.
- **Blocked by an Open Decision?** Yes, until GitHub access, source support/evidence scope, and branch snapshot semantics are decided.

#### IMP-06 — Implement file exclusion and sensitive-content handling

- **Description:** Apply the approved file exclusion policy to omit binaries, irrelevant/generated paths, `.env`/credential/private-key files, and other identified sensitive inputs. Prevent secret values from entering the generated profile and diagnostics.
- **Dependencies:** IMP-05 and DEC-04.
- **Expected output/artifact:** File selection/exclusion controls and input/output sensitive-content safeguards.
- **Acceptance criteria:** Exclusion behavior matches the approved policy; environment-variable names can be retained without values; tests demonstrate that prohibited values are not emitted.
- **Blocked by an Open Decision?** Yes, until exclusion rules, scanner, and processing boundary are selected in DEC-04.

#### IMP-07 — Implement repository source analyzers

- **Description:** Extract verifiable facts from the supported Java/Maven, JavaScript/Node.js, Docker, and GitHub Actions sources; inspect relevant configuration without executing repository-provided scripts.
- **Dependencies:** IMP-05, IMP-06, DEC-05.
- **Expected output/artifact:** Source analyzers and source-format support matrix.
- **Acceptance criteria:** Each supported source fixture yields facts with source references; unsupported/missing evidence is reported without guessing; binary/excluded paths are not analyzed.
- **Blocked by an Open Decision?** Yes, until parser/library and supported-version boundaries are decided in DEC-05.

#### IMP-08 — Implement evidence and coverage catalog

- **Description:** Store extracted claims with source references and status: supported, unavailable, unverifiable, incomplete, or conflicting. Apply repository files as primary sources and surface unclear conflicts.
- **Dependencies:** IMP-07 and DEC-05.
- **Expected output/artifact:** Evidence/coverage data model and conflict handling.
- **Acceptance criteria:** Every emitted claim can be traced using the agreed evidence convention; absent facts and unresolved conflicts are represented distinctly.
- **Blocked by an Open Decision?** Yes, until the evidence-reference format and conflict representation are decided in DEC-05.

#### IMP-09 — Implement the profile template and composer

- **Description:** Compose a consistently ordered Markdown candidate with the generated marker and all 16 mapped FR-12 fields: project name, description, language/runtime, frameworks/libraries, dependency names/versions, databases/data technologies, APIs/integrations, environment-variable names, build tool/commands, test framework/commands, CI/CD, deployment/infrastructure, security configuration, logging/monitoring, repository/default branch, and limitations/missing information.
- **Dependencies:** IMP-08 and DEC-05.
- **Expected output/artifact:** Versioned profile template and evidence-based composer for `technical-profile.md`.
- **Acceptance criteria:** Every field is emitted; missing evidence becomes `Not Specified`; unverifiable facts use `Unable to Verify` where applicable; conflicts are identified; generated claims are evidence-backed.
- **Blocked by an Open Decision?** Yes, until template/evidence representation and supported-source boundaries are finalized in DEC-05.

#### IMP-10 — Implement existing-profile reconciliation

- **Description:** Compare the current approved profile, read by IMP-05, with the newly composed candidate. Refresh generated sections from current evidence, retain manual content that cannot safely be reconciled, and mark it for reviewer attention.
- **Dependencies:** IMP-05, IMP-09, DEC-06.
- **Expected output/artifact:** Reconciliation component and reviewable change/diff representation.
- **Acceptance criteria:** Additions, modifications, and removals are visible; manual content is never silently deleted; unsafe-to-reconcile material is preserved and flagged; generation failure leaves the approved profile untouched.
- **Blocked by an Open Decision?** Yes, until the ownership/reconciliation mechanism is decided in DEC-06.

#### IMP-11 — Implement completeness, security, and consistency validation

- **Description:** Validate required fields and section order, secret/sensitive-value exclusion, required missing/unverifiable labels, conflict handling, generated marker, and profile structure on the reconciled candidate.
- **Dependencies:** IMP-06, IMP-08, IMP-09, IMP-10, DEC-04, DEC-05.
- **Expected output/artifact:** Automated profile validator and machine-readable validation result.
- **Acceptance criteria:** Any missing required field, invalid label/conflict handling, template/order violation, or prohibited secret blocks handoff; diagnostics identify the issue without exposing secret values.
- **Blocked by an Open Decision?** Yes, until file/content policies and evidence/template conventions are fixed in DEC-04/DEC-05.

#### IMP-12 — Build unit and integration test suites

- **Description:** Test configuration, GitHub adapter behavior, collection/filtering, analyzers, evidence catalog, composition, reconciliation, validation, and safe failure behavior using the selected test framework and appropriate repository fixtures/fakes.
- **Dependencies:** IMP-02 through IMP-11 and DEC-07.
- **Expected output/artifact:** Automated unit/integration test suites and representative fixtures.
- **Acceptance criteria:** Tests cover required fields/labels, conflicts, sensitive inputs/outputs, existing-profile preservation, no proposal after failures, and repeatable output for unchanged inputs where applicable.
- **Blocked by an Open Decision?** Yes, until the framework and validation strategy are selected in DEC-07; secret-test coverage also depends on DEC-04.

#### IMP-13 — Enforce the pre-handoff automated test gate

- **Description:** Wire the decided validation checks and automated tests into the run so the change-proposal component is unreachable unless the gate passes.
- **Dependencies:** IMP-11, IMP-12, DEC-07.
- **Expected output/artifact:** Gate/orchestration rule with explicit pass/fail result.
- **Acceptance criteria:** Required sections/fields, template order, sensitive-value exclusion, missing/unverifiable handling, conflict handling, failure preservation, and repeatability checks run as agreed; any failure prevents human-review handoff and PR creation.
- **Blocked by an Open Decision?** Yes, until gate execution/tooling is decided in DEC-07 and the scanner is decided in DEC-04.

#### IMP-14 — Implement change proposal and Pull Request workflow

- **Description:** Hand the reconciled diff to the selected review mechanism only after IMP-13 passes. Prefer a PR containing `technical-profile.md`; do not push unreviewed documentation directly to the default branch.
- **Dependencies:** IMP-03, IMP-04, IMP-10, IMP-13, DEC-03.
- **Expected output/artifact:** Reviewable change/PR creation path with least-privilege permissions.
- **Acceptance criteria:** A passing run exposes the change to a developer/designated reviewer; a failed gate creates no proposal/PR; approval is required before the change becomes final; PR failure leaves approved documentation unchanged.
- **Blocked by an Open Decision?** Yes, until the proposal mechanism and write permissions are decided in DEC-03.

#### IMP-15 — Implement run reporting and audit details

- **Description:** Report each run's result through the selected workflow/CLI interface, including generated/changed fields and access, partial-analysis, validation, gate, and proposal failures without leaking secrets or private content.
- **Dependencies:** IMP-03, IMP-05, IMP-11, IMP-13, IMP-14, DEC-01, DEC-08.
- **Expected output/artifact:** Run status/result reporting and safe diagnostic conventions.
- **Acceptance criteria:** Every run yields a clear outcome; changed documentation is identified; errors are actionable; diagnostics do not reveal credentials, secret values, or unauthorized repository content.
- **Blocked by an Open Decision?** Yes, until trigger/reporting interface and operational diagnostic policy are decided.

#### IMP-16 — Configure deployment and operational recovery

- **Description:** Deploy/package the workflow in the selected environment, provide approved credential configuration, and document rerun-based recovery, permissions, and operational limits.
- **Dependencies:** IMP-01, IMP-03, IMP-04, IMP-13 through IMP-15, DEC-01 through DEC-04, DEC-08.
- **Expected output/artifact:** Deployment/configuration instructions and operator runbook.
- **Acceptance criteria:** Setup does not embed credentials in source; access follows least privilege; failed runs preserve the last approved profile; operators can rerun and interpret the result.
- **Blocked by an Open Decision?** Yes, until runtime, hosting, credential, PR, and operational choices are resolved.

#### IMP-17 — Perform end-to-end and acceptance verification

- **Description:** Run the complete manual workflow against an authorized test repository covering supported project inputs, with and without an existing profile, and verify the review gate and failure paths.
- **Dependencies:** IMP-01 through IMP-16 and DEC-01 through DEC-08.
- **Expected output/artifact:** End-to-end results and acceptance checklist mapped to requirements.
- **Acceptance criteria:** A valid run produces a complete profile and reviewable diff; absent information is labeled, conflicts are visible, sensitive values are excluded, failures preserve the approved profile, and no change is handed off before all checks pass. Repeatability and the approved performance target are demonstrated under the decided test conditions.
- **Blocked by an Open Decision?** Yes, until all decisions affecting execution, GitHub, security, content support, validation, and benchmarks are resolved.

## 4. Task Dependencies

The required critical path is:

`DEC-01/02/04/05/06/07/08 -> IMP-01 -> IMP-02 -> IMP-03/04 -> IMP-05 -> IMP-06 -> IMP-07 -> IMP-08 -> IMP-09 -> IMP-10 -> IMP-11 -> IMP-12 -> IMP-13 -> IMP-14 -> IMP-15/16 -> IMP-17`

Additional dependency rules:

- DEC-03 depends on DEC-02; IMP-14 cannot start until DEC-03 is closed.
- IMP-06 must precede analyzer processing so excluded/sensitive content does not enter analysis.
- IMP-05 reads the existing `technical-profile.md` before IMP-09 generates a candidate; IMP-10 uses both inputs.
- IMP-13 is a strict prerequisite for IMP-14. No human-review handoff or PR creation occurs before the gate passes.
- IMP-17 depends on the integrated workflow and all required decisions; component tests in IMP-12 should be developed with their respective components where practical.

## 5. Blocked Tasks / Open Decisions

Decision tasks DEC-01 through DEC-08 should be completed before their dependent tasks are treated as implementation-ready. These decisions do not authorize changing the approved requirements or architecture; they select implementation details within those constraints.

| Open Decision | Affected tasks | Resolution needed |
|---|---|---|
| Execution environment, runtime, configuration location | IMP-01, IMP-02, IMP-03, IMP-15, IMP-16, IMP-17 | DEC-01: select runtime/hosting and safe configuration boundary. |
| Manual trigger interface | IMP-03, IMP-15, IMP-16, IMP-17 | DEC-01: choose workflow/CLI/manual invocation consistent with requirements. |
| GitHub API/interface and auth/credential provider | IMP-04, IMP-05, IMP-14, IMP-16, IMP-17 | DEC-02: choose access mechanism and minimum permissions for public/private repositories. |
| PR mechanism and permissions | IMP-14, IMP-16, IMP-17 | DEC-03: choose least-privilege write/handoff path; read-only access may not create a PR. |
| File exclusion policy and secret scanning/data boundary | IMP-06, IMP-11, IMP-12, IMP-13, IMP-16, IMP-17 | DEC-04: define exclusions, secret checks, provider boundary, and safe diagnostics; do not assume a tool. |
| Supported versions and source analyzer scope | IMP-05, IMP-07, IMP-09, IMP-17 | DEC-05: define parser/version coverage for Java/Maven, Node.js, Docker, and Actions. |
| Evidence-reference format | IMP-08, IMP-09, IMP-11 | DEC-05: specify how profile claims map back to repository evidence. |
| Exact profile template/field presentation | IMP-09, IMP-11, IMP-12, IMP-17 | DEC-05: retain all architecture-mapped FR-12 topics and order; decide template representation. |
| Existing-profile/manual-content ownership and reconciliation mechanism | IMP-10, IMP-11, IMP-12, IMP-17 | DEC-06: define safe preservation/flagging behavior without silent deletion. |
| Test framework and gate execution strategy | IMP-01, IMP-12, IMP-13, IMP-16, IMP-17 | DEC-07: select tooling and enforce the pass-before-handoff rule. |
| Performance benchmark and source snapshot semantics | IMP-05, IMP-08, IMP-17 | DEC-08: define representative repository, five-minute measurement, and branch-change behavior. |
| Retry, timeout, concurrency, run retention, diagnostic policy | IMP-03, IMP-15, IMP-16, IMP-17 | DEC-08: define initial operational behavior without weakening failure safety/privacy. |

Resolve first: (1) runtime/execution/manual trigger, (2) GitHub read authentication and the distinct PR permission path, and (3) sensitive-content exclusions/scanning/processing boundary. Then settle supported source versions, evidence/template contracts, reconciliation ownership, test gate/tooling, and performance/operational thresholds before their dependent implementation tasks begin.

## 6. Security Implementation Tasks

- **Credential and access controls:** Implement IMP-04 with minimum repository read scopes; keep any PR write credential/path distinct and least-privileged (DEC-03). Never place credentials in source or `technical-profile.md`.
- **Private repository boundary:** Limit collection and proposal visibility to the authorized GitHub workflow; resolve runtime/provider and retention handling in DEC-01/02/04.
- **Input minimization:** Implement DEC-04/IMP-06 exclusions for binary, irrelevant/generated, `.env`, credential, private-key, and other identified sensitive files.
- **Secret protection:** Apply the selected secret checks to the candidate before proposal; environment-variable names only, never values. Block handoff on a secret detection and avoid echoing secret material in diagnostics.
- **Safe execution:** Do not execute repository build/test scripts as part of analysis unless separately approved; inspect build/test commands as repository evidence only.
- **Failure safety:** Ensure collector, analyzer, reconciliation, validation, gate, and PR failures cannot replace or damage the last approved profile.
- **Least-privilege proposal:** Create reviewable change only after IMP-13 passes; never fall back to direct default-branch publication if PR/handoff fails.

## 7. Validation and Test Strategy

The exact framework, runner, GitHub test interface, and secret-scanning tool are Open Decisions. The strategy below defines coverage, not tool selection.

- **Unit tests:** Verify repository configuration/default-branch resolution, file filtering, analyzer extraction, evidence traceability/conflicts, profile field composition, status labels, reconciliation, and each validator rule.
- **Required-field/template validation:** Assert every mapped FR-12 field is present in consistent order and that the generated marker is present.
- **Evidence behavior:** Verify missing facts become `Not Specified`, unverifiable facts use `Unable to Verify` where applicable, conflicts are surfaced, and no unsupported facts are invented.
- **Security validation:** Use approved safe fixtures to prove prohibited secrets/sensitive values and environment-variable values do not appear in the generated artifact or user-visible diagnostics.
- **Reconciliation tests:** Cover absent profile, existing generated profile, manually maintained content, changed/obsolete facts, additions/modifications/removals, and content that cannot safely be reconciled. Confirm unsafe-to-reconcile content is preserved and flagged.
- **Failure-preservation tests:** Inject collection, analysis, reconciliation, validation, test-gate, and PR failures; verify approved documentation remains unchanged and no proposal is handed off when the gate fails.
- **Repeatability tests:** Run unchanged repository fixtures repeatedly and verify consistent profile output under the selected runtime/provider behavior.
- **Integration tests:** Exercise GitHub metadata/content access and proposal handoff using the selected test boundary; verify private-repository permission failures are reported.
- **End-to-end/performance tests:** Execute the manual flow against an authorized test repository, verify approval remains human-controlled, and measure the five-minute target against the DEC-08 benchmark.
- **Mandatory ordering:** Automated validation and the automated-test gate must pass before the change is made available for human review or a Pull Request is created. Gate failure blocks handoff and is reported.

## 8. Human Review / PR Workflow

1. A designated administrator/developer configures the single repository and manually triggers a run.
2. The system reads the current default-branch content, including the approved `technical-profile.md` when present, then collects and analyzes allowed evidence.
3. It composes the candidate and reconciles it with the existing profile. Any additions, modifications, and removals are visible in the proposed diff; unsafe-to-reconcile manual content is preserved and flagged.
4. The completeness, security, consistency, and automated-test gate runs. **No proposal or PR may be created or handed to a reviewer unless every required gate check passes.**
5. After a passing gate, the system creates the authorized reviewable change, preferably a Pull Request. The default-branch approved profile remains unchanged while review is pending.
6. A developer/designated reviewer inspects the diff and approves it. Only the approved repository review/merge process finalizes documentation.
7. The run output reports the result and changed documentation. Failed generation, validation, gate, or proposal handoff leaves the last approved profile intact.

## 9. Definition of Done

- The implementation supports one configured public or authorized private GitHub repository and resolves its current default branch.
- A designated user can manually trigger a run in the selected environment.
- Repository collection includes the existing profile when present and respects the approved file exclusions.
- The source analyzers cover the agreed Java/Maven, JavaScript/Node.js, Docker, and GitHub Actions versions and record traceable evidence.
- `technical-profile.md` contains every FR-12 field in the agreed template/order, is marked automatically generated, and uses the required missing/unverifiable/conflict behavior without invention.
- Existing generated sections are refreshed from current evidence; manual content is not silently removed; unreconcilable content is preserved and flagged; the diff makes changes/removals reviewable.
- The automated validation/test gate checks required fields/order, sensitive-value exclusion, missing/unverifiable/conflict handling, failure preservation, and repeatability as applicable.
- No review handoff or PR is possible unless the gate passes; a human must approve before publication.
- Failures leave the last approved profile unchanged and produce clear, secret-safe run output.
- Unit, integration, end-to-end, security, failure, repeatability, and performance acceptance checks pass according to the agreed test strategy and benchmark.
- Recovery instructions allow the operator to rerun the workflow, and no credentials/secrets are committed in source or generated documentation.

## 10. Implementation Risks

- **Unresolved choices can block the critical path:** Runtime, GitHub API/authentication, PR permissions, exclusion/scanning, evidence format, parser versions, and test tooling must be closed before dependent tasks. Track them through DEC-01 to DEC-08.
- **Read/write permission mismatch:** Repository analysis needs minimum read access, while automated PR creation may require additional write authority. Keep scopes distinct and least-privileged.
- **Secret exposure in intermediate processing:** Excluding known sensitive files and scanning output may not catch values in ordinary source/configuration files. Decide processing boundaries and test secret handling before using any external provider.
- **Manual-content loss during reconciliation:** Generated and manual sections may be difficult to distinguish. Preserve uncertain content, flag it, and inspect the diff; do not silently remove it.
- **Unsupported source formats:** Undefined version/file coverage can create incomplete profiles. Establish scope and consistently report unsupported/missing evidence rather than guessing.
- **Inconsistent generated output:** Model/runtime variation could undermine repeatability. Define and test repeatability against unchanged inputs before treating NFR-11 as met.
- **Unmeasurable performance target:** “Typical small-to-medium repository” is undefined until DEC-08 establishes a benchmark; do not claim the five-minute target before measurement.
- **Branch changes during a run:** Source-state semantics must be decided so evidence and profile refer to a coherent repository state.
- **Out-of-scope expansion:** Confluence, scheduled/event triggers, multi-repository runs, monorepo service profiles, and external cloud/package/deployment analysis remain out of scope for initial delivery.
