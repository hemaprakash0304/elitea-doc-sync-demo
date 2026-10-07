# DEC-08: Performance, Reliability and Operational Thresholds

## 1. Decision

Use bounded, observable, fail-safe execution. The approved approximate five-minute duration for a typical small-to-medium repository is a **target**, not an SLA or guaranteed completion time. It has not yet been benchmarked. DEC-04's resource caps are hard input limits; timeout and retry numbers remain **TBD — requires implementation benchmarking/configuration**.

Each run is bound to one immutable default-branch commit snapshot. Collection reads that snapshot, not a moving branch. Before proposal creation, the current default-branch head must still equal the analyzed snapshot. If it differs, invalidate the candidate and gate result and restart collection, analysis, and the complete gate on the new snapshot; do not propose stale output.

Allow at most one proposal-capable run per normalized target repository. Concurrent requests for a target fail fast with a sanitized busy result; they are not queued with stale candidates. Retries are finite and limited to safe transient reads. Validation, scanning, parser, test, reconciliation, and other deterministic failures are not retried automatically. Any timeout, cancellation, incomplete required stage, or failed gate prevents branch/PR creation and preserves the approved profile.

## 2. Options Considered

| Option | Assessment |
|---|---|
| No performance target | Rejected; NFR-08 establishes an approximate five-minute target for a typical small/medium repository. |
| Fixed hard timeout equal to five minutes | Rejected; the five-minute value is a target, not an approved hard limit, and there is no implementation benchmark yet. |
| Target plus configurable stage/overall timeouts | Selected; retain the target, measure first, and set finite timeout values during implementation configuration. Timeouts must cancel/fail safely. |
| Unlimited retries | Rejected; risks runaway runs, excess API use, and stale/duplicate proposals. |
| Bounded retries for safe transient reads | Selected; use a finite configured attempt/deadline budget, honor GitHub `Retry-After`/rate-limit guidance, and stop when exhausted. Numeric retry count/backoff remain TBD. |
| Blind retries for all failures | Rejected; validation/security failures are not transient, and blind write retries can create duplicate branches/PRs. |
| Concurrent proposal-capable runs for one repository | Rejected; can cause duplicate proposals and stale or racing candidates. |
| One active proposal-capable run per target | Selected; fail fast on a concurrent invocation, keyed to the normalized target. |

## 3. Repository Size and Workload Limits

Use DEC-04 limits exactly; do not introduce conflicting caps:

| Limit | Approved value | Operational behavior |
|---|---:|---|
| Eligible file size | 2 MiB maximum per file | Exclude an oversized ordinary input and mark affected analysis incomplete. If the existing `technical-profile.md` exceeds this limit, stop reconciliation and preserve it unchanged. |
| Eligible text size | 20 MiB maximum total per run | Process a deterministic sorted subset only if the omitted remainder is explicitly reported and the required scan/coverage checks still pass; otherwise fail the gate. Never imply omitted text was analyzed. |
| Eligible file count | 5,000 maximum per run | Apply deterministic path ordering; report omitted files and incomplete coverage. Gate blocks if scanner coverage or required status reporting is incomplete. |
| Repository count | One configured target per run | Reject multiple repositories, service selectors, or cross-repository expansion. |

These are hard collection/input limits, not a promise that every repository within them finishes within five minutes. Keep DEC-04's exclusions, UTF-8/text-only policy, and no-symlink/no-submodule behavior.

## 4. Performance Target and Benchmarking

- **Target:** Approximately five minutes for a representative small-to-medium repository, as stated by NFR-08. This is an objective to measure, not a guaranteed SLA or current achieved benchmark.
- **Representative workload:** DEC-08 benchmark configuration must document repository characteristics (eligible file count, total eligible bytes, largest eligible file, supported technology mix, and whether an existing profile/manual notes are present). Use an authorized test repository with safe content; do not use production secrets or private customer content for benchmarking.
- **Measurements:** Capture total elapsed time and separate durations for:
  1. GitHub metadata/snapshot resolution and content collection
  2. Path filtering and secret scanning
  3. Source analysis
  4. Evidence catalog construction and ID assignment
  5. Profile composition
  6. Existing-profile reconciliation
  7. Completeness/security/consistency validation
  8. Automated test gate
  9. Proposal/PR handoff, reported separately from analysis/gate duration
- **Additional context:** Record run ID, target identity (not credentials), analyzed commit/ref, eligible file count/bytes, excluded-file counts by safe category, scanner/parser versions, and stage result/duration. Diagnostics contain no file snippets or secret values.
- **Benchmark status:** No benchmark is claimed by this decision. First-run baseline and representative workload are **TBD — requires implementation benchmarking/configuration**. If the target is missed, profile and report the result; do not weaken exclusions, scanning, validation, or approval to meet timing.

## 5. Timeout Strategy

All operations use finite, configurable deadlines. Expiry cancels the stage where possible, marks it failed/incomplete, stops downstream processing, prevents proposal handoff, and preserves the approved profile. The five-minute target is not itself a timeout.

| Scope | Timeout policy |
|---|---|
| GitHub API operation | Finite per-request timeout; exact value **TBD — requires implementation benchmarking/configuration**. Respect server-directed rate-limit delays only within the overall run deadline. |
| Repository collection | Finite stage deadline; exact value **TBD — requires implementation benchmarking/configuration**. Partial collection is reported and cannot be presented as complete. |
| Secret scanning | Finite stage deadline; exact value **TBD — requires implementation benchmarking/configuration**. Incomplete scan is blocking. |
| Source analyzers | Finite stage deadline; exact value **TBD — requires implementation benchmarking/configuration**. Timed-out analyzer output is not trusted. |
| Validation | Finite stage deadline; exact value **TBD — requires implementation benchmarking/configuration**. No pass result before deadline means gate failure. |
| Automated tests | Finite stage deadline; exact value **TBD — requires implementation benchmarking/configuration**. Incomplete/skipped/timed-out required tests fail the gate. |
| Complete workflow | A finite overall deadline is required; exact value **TBD — requires implementation benchmarking/configuration**. On expiry, cancel remaining stages and do not start or continue proposal handoff. |

Timeouts must not produce or hand off a partial profile. A timeout after a proposal branch operation begins follows DEC-03 idempotency/recovery rules; it must never trigger a fallback write to the default branch.

## 6. Retry Strategy

- Retry only transient, idempotent GitHub reads/network failures (for example, retryable server errors or rate limiting) within both a finite attempt budget and the overall run deadline. Respect `Retry-After` and GitHub rate-limit reset guidance; do not retry earlier than directed.
- The maximum read retry count/backoff policy is finite but **TBD — requires implementation benchmarking/configuration**. Report retry count and final sanitized failure category.
- Do not retry authentication/authorization failures, invalid targets, secret findings, incomplete secret scans, malformed profiles, deterministic parser/validator failures, failed tests, or any other security/integrity failure. These require correction or human action.
- Do not blindly retry non-idempotent branch/commit/PR operations. On ambiguous write outcome, query GitHub for the deterministic run/candidate identifier and existing branch/PR state. Reuse an exact matching proposal only after rerunning the full gate; otherwise fail for human/operator resolution. The exact branch/PR idempotency key is an implementation detail, not permission to bypass the gate.
- After retry exhaustion: fail the run, preserve the approved profile, create no proposal unless a prior write is confirmed to be the exact gate-bound candidate, and provide sanitized diagnostics.

## 7. Concurrency and Duplicate Runs

- Permit at most one proposal-capable run per normalized target repository at a time. A concurrent invocation for that target returns a sanitized `BUSY`/already-running result and does not start a second proposal flow. Do not queue a candidate that may become stale.
- Key the execution lock/concurrency group by canonical repository identity, not caller-provided capitalization or branch name. Hold it from snapshot selection through proposal result reporting, then release it on success, failure, timeout, or cancellation.
- GitHub Actions is the only initial automated write path (DEC-03). Local CLI runs may read, analyze, validate, and prepare local output but have no PR/write credential; use a local process lock for the same local workspace.
- Before PR creation, check for an existing open proposal for the same target and candidate/snapshot. If an exact matching proposal already exists, report it rather than creating a duplicate. If an open proposal differs, stop and report for human resolution; do not overwrite or close a reviewer-owned proposal automatically.
- Lock acquisition/release mechanism is an implementation configuration choice; the one-active-proposal-run policy is mandatory. Do not add external queue or lock infrastructure without a separate approved decision.

## 8. Snapshot Consistency

1. Resolve the selected repository's current default branch and record its commit SHA/ref at run start.
2. Collect all content, including existing `technical-profile.md`, from that immutable commit snapshot. Do not mix reads from a moving branch tip.
3. Bind evidence, candidate digest, validation/test result, and run record to the same target and snapshot SHA.
4. Immediately before creating a proposal branch/PR, re-read the default-branch head. It must still equal the analyzed snapshot SHA. If it changed, mark the result stale, discard the candidate/gate result, and rerun the complete pipeline on the new snapshot.
5. Create the proposal branch from the validated snapshot SHA. Recheck the default-branch head immediately after PR creation to detect a race during handoff. If it advanced, mark the proposal stale, close it without merge where the approved DEC-03 mechanism permits, report the condition, and rerun analysis/gate before a replacement proposal. Never merge stale output.
6. An age-only staleness threshold is not used; snapshot identity equality is the rule. The exact GitHub API sequencing/recovery mechanics remain implementation work, but a candidate must not knowingly be proposed against a different snapshot.

## 9. Reliability and Failure Recovery

| Failure | Required behavior |
|---|---|
| GitHub unavailable or transient read errors exhausted | Fail the run, report sanitized service failure, create no proposal, preserve approved profile; operator may rerun. |
| Authentication, authorization, or repository access failure | Fail clearly; do not broaden credentials or try another repository; preserve approved profile. |
| Collection incomplete or required snapshot file unavailable | Report incompleteness; continue only where requirements/DEC-04 allow and all gate checks can still pass. Otherwise fail closed. |
| Scanner, analyzer, validator, or required test failure | Stop before proposal; do not publish partial output; preserve approved profile. |
| Reconciliation/profile invalidity | Preserve original profile byte-for-byte, flag for human review, and create no branch/PR. |
| Workflow cancellation or runner failure before proposal | Do not expose the write credential or create a proposal; preserve approved profile. Clean temporary workspace through normal process cleanup without logging file content. |
| Proposal/PR failure after gate | Default branch remains unchanged. Do not fallback to a direct write. Report any candidate branch/PR state for safe operator follow-up; automatic cleanup only if explicitly supported by DEC-03. |
| Snapshot changes during run | Invalidate the candidate/gate result and rerun from the new SHA; do not propose stale output. |
| Existing open PR or interrupted prior proposal | Recheck candidate/snapshot identity and rerun the full gate before reuse. Do not create duplicates or overwrite a nonmatching reviewer-owned proposal. |

In every unsafe or incomplete case, the last approved `technical-profile.md` remains unchanged. Recovery is a new run from a fresh snapshot; no partial or unvalidated profile is published.

## 10. Observability and Diagnostics

Record a run record containing:

- Unique run identifier and execution context (Actions or local)
- Canonical target repository identity and analyzed default branch/commit SHA
- Start/end timestamps and overall duration
- Per-stage start/end duration and result: collection, filtering/scanning, analysis, evidence, composition, reconciliation, validation, tests, and proposal
- Eligible/excluded file counts and byte totals, using sanitized exclusion categories
- Scanner/parser/validator/test versions and policy/template versions
- Validation result, test result, scan coverage/result, gate result, proposal branch/PR identifier/result, and retry count
- Sanitized failure category and recovery guidance

Never record tokens, passwords, keys, secret values, raw scanner output, sensitive source snippets, raw API bodies, authorization headers, environment dumps, or credential-bearing URLs. Redact or omit paths/locators if they could themselves expose sensitive information. Retention duration and storage destination are **TBD — requires implementation benchmarking/configuration** and must remain inside the authorized workflow.

## 11. Idempotency and Recovery

- **Successful no-op:** If the reconciled candidate equals the approved profile and no manual changes are proposed, report success/no change and do not create a branch or PR.
- **Failed previous run:** Leave the approved file untouched. A rerun starts from a fresh default-branch snapshot and repeats all stages.
- **Interrupted run:** Temporary candidate data is not trusted as gate-passed. Resume only after re-reading source state and rerunning the full gate; do not reuse write credentials.
- **Stale candidate:** If snapshot SHA or candidate digest no longer matches the gate record, discard it and rerun from collection.
- **Existing open proposal:** If it matches the exact target, snapshot, and candidate digest, report/reuse it only after a fresh complete gate. If it differs, do not update/close it automatically; report and require reviewer/operator resolution.
- **Transient GitHub read failure:** Retry only within the bounded DEC-08 read policy. After exhaustion, preserve approved content and allow a fresh manual rerun.
- **Partial proposal write:** Detect exact branch/PR state before retrying. Never issue duplicate commits/PRs blindly and never write to the default branch.

## 12. Operational Thresholds

| Area | Target / limit | Blocking? | Action |
|---|---|---|---|
| Eligible file size | 2 MiB maximum (DEC-04) | Oversized ordinary input: incomplete field/coverage; existing profile over limit: yes | Exclude and report; if `technical-profile.md` exceeds limit, preserve and stop reconciliation. |
| Total eligible content | 20 MiB maximum (DEC-04) | Blocks if required scan/coverage cannot complete | Apply deterministic ordering; report omissions and mark profile incomplete; never claim omitted evidence. |
| Eligible file count | 5,000 maximum (DEC-04) | Blocks if required scan/coverage cannot complete | Exclude remainder in stable order, report count/status, fail gate if coverage is not complete enough to validate safely. |
| Performance target | Approximately 5 minutes for a typical small/medium repo (NFR-08); not a guaranteed SLA | No, by itself | Measure per stage and total; representative workload and achieved baseline TBD — requires implementation benchmarking/configuration. |
| GitHub API timeout | Finite per-request timeout; numeric value TBD — requires implementation benchmarking/configuration | Yes on timeout after safe retries | Cancel request/stage, report sanitized timeout, preserve approved profile. |
| Secret scan timeout | Finite scan-stage timeout; numeric value TBD — requires implementation benchmarking/configuration | Yes | Treat as incomplete scan; no proposal/PR. |
| Analysis timeout | Finite analysis-stage timeout; numeric value TBD — requires implementation benchmarking/configuration | Yes if required analysis incomplete | Discard partial candidate; report incomplete stage; preserve approved profile. |
| Validation/test timeout | Finite gate deadline; numeric value TBD — requires implementation benchmarking/configuration | Yes | No explicit passing gate result, so no proposal credential/branch/PR. |
| Overall workflow timeout | Finite overall deadline; numeric value TBD — requires implementation benchmarking/configuration | Yes | Cancel remaining work, fail closed, preserve approved profile. |
| Retry count | Finite bounded retries for safe idempotent reads; maximum count/backoff TBD — requires implementation benchmarking/configuration | Exhaustion is yes | Honor GitHub rate-limit/retry guidance; do not retry deterministic/security failures or blindly retry writes. |
| Concurrency policy | Maximum one proposal-capable run per target repository | Yes for a competing run | Fail fast as busy; do not run concurrently or queue a stale candidate. |
| Snapshot staleness | Default-branch head must equal analyzed snapshot SHA at pre-proposal check | Yes; no age-only grace | Invalidate and rerun all stages on changed SHA; detect post-creation race and close/mark stale without merge. |
| Validation/test gate | Every required check must have explicit pass | Always | Any failure, skip, cancellation, missing/unknown result, or stale binding means no proposal/PR. |

Values marked TBD are intentionally unresolved until the implementation measures a representative workload and selects runner/API behavior. They must be set to finite operational values before production use; they must not be represented as achieved guarantees before measurement.

## 13. Impact on Implementation Tasks

- **DEC-01:** Retain the GitHub-hosted manual workflow and shared local CLI; configure one target per run. No always-on service or queue is added.
- **IMP-01:** Add runtime/test setup capable of reporting stage durations and enforcing finite deadlines; exact values follow benchmarking.
- **IMP-03:** Make run coordination deadline-aware, cancellation-safe, and single-flight for a target; return a sanitized busy/failure result.
- **IMP-04:** Bound GitHub API reads and use safe transient-read retries only; never broaden credentials after access failure.
- **IMP-05:** Pin collection to the resolved default-branch SHA, enforce DEC-04 caps, and recheck the SHA before proposal.
- **IMP-06:** Include filter/scanner duration and coverage in run telemetry; any incomplete security scan blocks.
- **IMP-07:** Bound analyzer execution and discard incomplete output on timeout.
- **IMP-11:** Give validation a finite deadline; absent explicit pass is failure.
- **IMP-12:** Run required tests under a finite deadline and preserve individual stage outcomes.
- **IMP-13:** Bind gate success to target, source SHA, candidate digest, and tool/policy versions; gate failures/skips/cancellation block handoff.
- **IMP-15:** Record safe run/stage metadata, retry counts, snapshot identity, gate and PR status; redact secrets and private response content.
- **IMP-16:** Configure target-keyed concurrency, timeout/retry values after benchmark, safe cancellation/recovery, and operator diagnostics.
- **IMP-17:** Benchmark a representative repository and test stale-snapshot, concurrency, retry, timeout, idempotency, and failure-preservation behavior before claiming NFR-08.

## 14. DEC-08 Status

**READY FOR APPROVAL**