# DEC-07: Testing Strategy and Mandatory Validation/Test Gate

## 1. Decision

**DEC-07 Status: READY FOR APPROVAL**

Use layered automated tests: unit tests for deterministic components, integration tests for component and GitHub boundaries, and end-to-end tests for the complete workflow. Add deterministic profile validation and DEC-04 secret scanning as required gate checks. Manual review is complementary; it does not replace automated validation.

The gate is a mandatory prerequisite to handing a change to a reviewer or making the DEC-03 proposal job's write credential available. It must fail closed. Any failed, skipped, cancelled, timed-out, unavailable, incomplete, or indeterminate required check prevents branch and Pull Request creation. No test framework, runner, GitHub test interface, or scanner beyond DEC-04's approved Gitleaks choice is selected here; those remain implementation choices.

A passing result must be bound to the exact target repository, default-branch snapshot/commit, candidate `technical-profile.md` digest, template/schema version, validator/test versions, and DEC-04 scanner/rules version. Any input, candidate, rules, or relevant configuration change invalidates the result and requires the full gate to run again. Only the unchanged candidate associated with that passing result may be handed to the DEC-03 proposal job.

## 2. Options Considered

| Approach | Advantages | Limitations | Decision |
|---|---|---|---|
| Unit tests only | Fast and useful for isolated parsers/rendering. | Does not verify component boundaries, GitHub behavior, workflow ordering, or end-to-end safety. | Reject as insufficient alone. |
| Integration tests only | Exercises connected components and adapters. | Slower diagnosis; leaves parsing, status rules, reconciliation edge cases, and deterministic rendering less precisely covered. | Reject as insufficient alone. |
| Manual validation only | A reviewer can inspect the proposed diff and notice contextual issues. | Inconsistent, not repeatable, and cannot reliably enforce secret scanning, full field coverage, or gate ordering. | Reject as a substitute for automated checks. Manual PR review remains required. |
| Automated validation without automated tests | Can check a particular candidate's schema and output. | Does not prove parsers, reconciliation, failure preservation, or repeatability behave correctly across cases. | Reject as insufficient alone. |
| Unit + integration + end-to-end tests, with a deterministic candidate validator and secret scan before proposal | Covers components, boundaries, user workflow, profile contract, security, and failure gates; repeatable and auditable. | More setup and test maintenance; GitHub end-to-end tests require an isolated test target and controlled test credentials. | **Selected.** It is the smallest strategy that verifies the approved behavioral boundaries end to end. |

## 3. Validation Gate

The gate operates on one immutable run input and one reconciled candidate. Its required checks are:

1. **Target and snapshot binding:** Exactly one configured target; current default-branch snapshot and commit/ref captured; no branch override or unrelated repository input. Candidate and gate result identify the same target/snapshot.
2. **Template contract:** Exactly the 16 DEC-05 top-level sections, exact section names and order, no missing or duplicate sections, and no unexpected top-level sections. Markdown is parseable under the selected template rules.
3. **Required fields and generated marker:** Every DEC-05 required field is present; the generated marker is present and correctly formed. Fields with no evidence contain `Not Specified`; evidence that cannot be verified uses `Unable to Verify`; source conflicts use `Conflict` with evidence references.
4. **Ownership and reconciliation:** All generated ownership markers, schema versions, start/end pairs, and digests validate. Every recognized manual subsection from a valid input profile is preserved byte-for-byte and in place. Unclassified/malformed input blocks the gate. Additions, modifications, and removals are visible in the candidate diff.
5. **Evidence integrity and factuality:** Every factual value has one or more valid evidence IDs and sanitized source locators in the DEC-05 ledger. Evidence IDs resolve to records. `Verified` claims are supported by the permitted deterministic sources; low-confidence/unsupported claims are not stated as verified. Conflicts are retained, and no claim may be invented or silently selected from conflicting sources.
6. **Secret and sensitive-content checks:** DEC-04 input scans completed for every eligible file; excluded inputs did not reach analyzers; the final reconciled candidate passes the same scanner and deterministic sensitive-value checks. Environment-variable values, credentials, secrets, raw snippets, or prohibited files in the candidate are blocking failures.
7. **Coverage and completeness status:** Excluded, unsupported, missing, and unverifiable evidence is reflected in affected field statuses and the limitations section. A safely excluded source finding may produce a partial profile only when its omission is represented accurately and all scans/output checks completed. Incomplete scanner coverage is always blocking.
8. **Repeatability:** For the same repository snapshot, template/schema, scanner/rules, and configuration, deterministic extraction, reconciliation, evidence IDs/order, and rendering produce the same candidate bytes. Any nondeterministic component must be normalized or cause the repeatability check to fail.
9. **Failure preservation:** Tests establish that collection, scanning, parsing, reconciliation, validation, test-gate, and proposal failures cannot alter the approved `technical-profile.md`. The target's approved file remains unchanged until human-approved merge.
10. **Changed-file boundary:** The proposal contains only the reconciled `technical-profile.md` change. No source files, unrelated files, credentials, test fixtures, logs, or scanner artifacts may be included.
11. **Automated test result:** All required unit, integration, reconciliation, security, and end-to-end gate tests pass. A missing result, skipped required test, cancellation, timeout, tool unavailability, or inconclusive result is a failure.

**Blocking failures:** Any failed or absent required check; changed snapshot/candidate after the gate; incomplete DEC-04 scan; secret/sensitive content in the candidate; malformed or unclassified existing profile; invalid template/field/status/evidence; unresolved required conflict handling; failed manual-content preservation; nondeterministic output; failure-preservation regression; or any changed file other than the permitted profile. These failures produce a sanitized run result, no branch/PR, and no release of the proposal App credential.

A source secret-like match in an eligible file is not automatically a whole-run failure: DEC-04 allows excluding that file and continuing if coverage remains complete for the selected input set, affected fields are marked accurately, and the candidate passes the full output gate. A scanner failure, unreadable eligible input, uncertainty about scan completion, finding in the existing profile, or candidate output finding is blocking.

The workflow must enforce this as a job dependency: the DEC-03 proposal job runs only on an explicit successful gate result for the bound candidate. It receives its write credential only in that post-gate job. No local/manual bypass may create a proposal without the same gate.

## 4. Test Levels

### Unit Tests

- **Parsers/analyzers:** Exercise supported Maven/package manifests, lockfiles, Docker/compose, GitHub Actions, Markdown, configuration, and eligible source patterns. Assert exact extracted values, source locators, and authority rules.
- **Evidence model:** Verify status transitions, confidence restrictions, stable Evidence ID ordering, sanitized locators/facts, multiple evidence references, and conflict preservation.
- **Template/rendering:** Verify all 16 exact headings/fields, section order, generated marker, `Not Specified` defaults, evidence rows, stable formatting, line endings, and byte-for-byte repeatability.
- **Reconciliation:** Verify block recognition, schema/digest checking, generated field replacement, preservation of manual subsections, and blocking behavior for unclassified content.
- **Filtering/scanning:** Test DEC-04 exclusion matching before reads, synthetic secret detections, redaction, output checks, and fail-closed scanner errors without using real credentials.
- **Validator:** Exercise every gate rule independently, including unsupported/low-confidence claims, invalid evidence IDs, missing statuses, malformed tables, duplicate/misordered sections, and disallowed changed paths.

### Integration Tests

- Verify the shared pipeline ordering: collect snapshot, filter, scan inputs, parse, catalog evidence, render, reconcile, scan candidate, validate, run tests, then report a gate result.
- Test GitHub metadata/default-branch and content adapters with controlled mocks/fixtures; separately test authorized access against a dedicated non-production test repository when available. Use dedicated non-production test credentials, never production credentials or secret fixtures.
- Verify the selected target snapshot is immutable for the run and a target mismatch fails closed.
- Verify excluded paths, binary files, symlinks, submodules, invalid encodings, and resource limits cannot leak into analyzers.
- Verify only the profile candidate is passed to proposal after a passing gate, and that the proposal job cannot start on gate failure, skip, cancellation, missing result, or changed candidate.

### End-to-End Tests

Run the manual workflow using a safe test repository/snapshot with both first-generation and existing-profile cases. Exercise the actual orchestration from trigger through analyzer, evidence ledger, candidate, reconciliation, validation/test gate, and proposal boundary.

For PR-flow verification, use a dedicated isolated non-production test repository and the approved test proposal App only after the test gate passes. Verify the branch contains only `technical-profile.md`, the PR targets the current default branch, the proposal identity cannot bypass protection or merge, and human approval is still needed. If an isolated GitHub test repository/App is unavailable, the PR integration portion remains unverified and cannot be marked passed; do not substitute production credentials or relax branch protection.

End-to-end checks also verify safe diagnostics, no secret-bearing artifacts, preservation of the approved profile on every injected failure, no-op behavior (no empty PR), and the DEC-08 performance target under its defined repository profile.

## 5. Functional Test Scenarios

Use synthetic repository snapshots with evidence fixtures and assert both the resulting profile/statuses and whether the gate allows proposal handoff.

| Scenario | Expected result |
|---|---|
| First generation; no existing profile | Render all 16 sections and required fields, statuses, generated marker, ownership markers/digests, and evidence ledger. Gate may pass only if all required checks pass. |
| Unchanged existing generated profile | Preserve equivalent field values and manual notes; refresh evidence IDs only as dictated by the current snapshot; stable candidate bytes produce no-op/no empty PR. |
| New evidence | Add the fact and evidence reference in the correct generated field; diff shows the addition. |
| Changed evidence | Update the generated value/status and evidence links; diff shows old versus current repository evidence. |
| Obsolete generated information | Remove the unsupported generated value, show the removal, and use `Not Specified` or an explicit evidence-backed change note. Do not imply real-world teardown from absence alone. |
| `Not Specified` | Emit the literal status/value for a required field with no eligible evidence. |
| `Unable to Verify` | Emit the status when evidence exists but is unsupported, inaccessible, excluded, ambiguous, or insufficient; do not retain the old value as verified. |
| Conflicting evidence | Emit `Conflict`, cite each credible source, and block or pass only according to the gate's explicit conflict representation; never silently select one. |
| Manual content preservation | Preserve a valid `### Human-maintained notes` subsection byte-for-byte and in place; flag conflicting notes without rewriting them. |
| Malformed profile | Preserve input unchanged, report a sanitized reason, block candidate handoff/PR. |
| Legacy/unclassified profile | Do not infer ownership from the global generated marker or history; preserve and flag for human review, no automatic replacement/PR. |
| Digest mismatch or edit inside generated block | Treat ownership as unclassified; preserve approved profile and block proposal. |
| Missing, duplicate, or malformed ownership marker | Fail reconciliation and block proposal; preserve the approved profile. |
| Missing required section/field | Validator fails; no proposal/PR. |
| Wrong section order or extra top-level heading | Validator fails; no automatic reordering/removal; preserve existing profile. |
| Scanner detects secret in eligible source | Exclude entire source file, expose only sanitized finding metadata, mark affected fields incomplete, and continue only if remaining input scans and output gate are complete and clean. |
| Secret finding in existing profile or generated candidate | Fail closed; no proposal; preserve existing approved profile and redact all diagnostics. |
| Scanner unavailable, timeout, parse error, unreadable eligible file, or partial scan | Fail closed; no proposal/PR; preserve approved profile. |
| Gate skipped, cancelled, missing, or stale result | Treat as failure; do not release proposal credential or create branch/PR. |
| Unrelated file appears in candidate change | Changed-file boundary fails; block proposal. |
| Failure-preservation injection | For each pipeline/proposal failure, approved profile bytes remain unchanged and recovery requires rerun/revalidation. |
| Same snapshot and policy rerun | Output, evidence IDs/order, markers/digests, and diff are deterministic; no spurious PR is created. |