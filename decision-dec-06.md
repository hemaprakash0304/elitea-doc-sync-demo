# DEC-06: Existing Technical Profile Reconciliation and Manual Content Preservation

## 1. Decision

**Status: READY FOR APPROVAL**

Treat an existing `technical-profile.md` as an input and read it before composing a candidate. Automatically refresh only generated blocks that have valid ownership markers, supported schema, and a matching content digest. Preserve recognized human-maintained notes byte-for-byte outside generated blocks. If existing content is unmarked, malformed, modified inside a generated block, or cannot be classified safely, preserve the approved file and block automated proposal handoff; report what needs human review. Never assume an entire existing profile is safe to overwrite.

Keep DEC-05's 16 required H2 sections, required fields, order, generated-document marker, evidence statuses, and evidence ledger. Add invisible per-section HTML ownership markers around generated tables; markers do not add or reorder visible sections. Keep DEC-03's rule that a passing validation/test gate precedes proposal creation and that publication requires human approval.

## 2. Existing Profile Detection and Classification

- Read exactly the root-level `technical-profile.md` from the selected target's current default-branch snapshot before composing a replacement. Do not search other branches, history, or other repositories for a prior version.
- Apply DEC-04 size, UTF-8, and secret-scan checks before parsing. If the file exceeds limits, is not valid UTF-8, contains a secret-like finding, or cannot be safely parsed, stop reconciliation, leave the approved file unchanged, report a sanitized reason, and do not create a proposal.
- If the file does not exist, classify the run as first generation. Build the complete DEC-05 template with all required fields and ownership markers, validate it, and hand it off only after the gate passes.
- A profile is a supported generated profile only when it has the DEC-05 generated marker, exactly the required 16 H2 sections in order, all required fields, one valid generated-block start/end pair per section, supported schema version, and a matching SHA-256 digest for each generated block.
- A `### Human-maintained notes` subsection outside generated blocks is classified as manual and preserved byte-for-byte in its existing parent section. The reconciler may add this subsection when a reviewer explicitly chooses to preserve manual notes during a reviewed migration; it must not silently move or rewrite the note text.
- Existing unmarked text outside generated blocks that is not within a recognized human-maintained notes subsection, unexpected H2 sections, duplicate/missing markers, invalid marker nesting, duplicate required fields, unknown schema versions, or digest mismatches are **unclassified/unsafe**. Preserve the existing profile and block automatic reconciliation/PR. Report the issue for human review; do not guess ownership or discard content.
- A global generated-document marker alone does not prove that all content is machine-owned. Legacy DEC-05 profiles without per-section ownership markers are treated as unclassified until a human resolves or migrates them.

## 3. Generated vs Manual Content

Each required section retains the exact DEC-05 heading and field/table contract. Wrap only the system-owned field table in a hidden ownership block:

```markdown
<!-- docs-sync:generated:start section=01 schema=1 sha256=<digest> -->
...DEC-05 table rows for this section...
<!-- docs-sync:generated:end section=01 -->
```

Use section IDs `01` through `16` in the DEC-05 order. The digest is SHA-256 over the exact UTF-8/LF-normalized bytes between the marker lines, excluding the marker lines. The generator verifies the digest before treating a block as unchanged generated content, then writes a new digest after rendering. This marker/digest detects unclassified edits; it is an ownership/integrity aid, not a signature or security boundary.

Classification rules:

- **Generated:** Content inside a valid supported marker pair whose digest and table schema validate. It may be refreshed from current evidence.
- **Previously generated:** A generated block from an earlier run that still passes schema/digest validation. Compare it with the new evidence-backed block to produce a diff.
- **Manual:** Text inside an allowed `### Human-maintained notes` subsection outside a generated block. Preserve byte-for-byte and never replace automatically.
- **Unclassified:** Any content whose ownership, boundaries, schema, encoding, or digest cannot be verified. Preserve the existing file and block proposal handoff pending human action.

Manual notes that disagree with current generated evidence remain intact and visible. The newly generated field/status and evidence identify the discrepancy; add a safe review flag in `Limitations / Missing Information` without rewriting the manual note. A reviewer decides whether to edit or remove manual material.

## 4. Reconciliation Strategy

Reconcile each DEC-05 field independently only inside a valid generated block. Render a complete candidate from the current evidence model, compare it with the previous generated block, and produce a unified diff. Keep the fixed section/field order and all required fields.

| Existing generated value | Current evidence/candidate | Reconciliation |
|---|---|---|
| Unchanged verified value | Same verified value | Retain the value; refresh evidence IDs/locators if the current snapshot assigns different evidence. The diff shows evidence-only changes when applicable. |
| No prior value | Verified value now available | Add the value with status and evidence IDs; show the addition. |
| Prior value differs | Current verified value differs | Replace only the generated value with the current evidence-backed value; show old and new values in the diff. Preserve associated human notes outside the generated block. |
| Prior generated value no longer supported | Complete scan finds no eligible evidence | Remove the unsupported generated value and render `Not Specified` for an otherwise empty required field. Add a safe limitation that the repository snapshot no longer specifies it; do not claim the real-world system was removed. |
| Prior value's evidence is excluded, unreadable, unsupported, or incomplete | Cannot establish current state | Replace its generated status/value with `Unable to Verify` and explain the evidence gap without retaining the old value as verified. If the scan itself is incomplete or unsafe, fail the gate rather than proposing. |
| Credible current sources disagree | Conflict | Render `Conflict`, include evidence IDs for the competing claims, and do not select one silently. The diff shows the status/value change. |
| Previously manually added content | Outside valid generated block | Preserve verbatim, keep in place, and flag if it conflicts with current evidence. Never auto-delete or rewrite it. |
| Generated block edited or ownership uncertain | Digest/schema/marker check fails | Do not replace the block. Preserve the approved profile and block the proposal until human review resolves ownership. |

An absence of repository evidence is not proof that a real-world service, integration, database, or deployment no longer exists. Only repository-supported statements may be changed in the generated profile. Explicit repository changes may justify removing an old generated repository claim, but the diff must show the removal and the resulting status/limitation. Every removal remains visible to the reviewer.

## 5. Evidence Changes and Removals

- Rebuild evidence for the current snapshot; do not copy prior evidence IDs as proof. IDs and locators are generated deterministically from the current evidence catalog.
- If evidence disappears and the scan completed successfully, replace the old generated claim with `Not Specified` and a note that the current repository snapshot does not specify the fact. Do not retain the old value as verified.
- If evidence is present but cannot be verified, use `Unable to Verify`; if the old claim depended on excluded/inaccessible content, do not silently keep it as current.
- If evidence changes, refresh the generated field and evidence references. A stronger authoritative source may supersede a weaker README claim according to DEC-05's field-specific authority rules; show the resulting change and retain references to the conflicting/overridden evidence in the ledger or limitation note.
- If credible sources conflict and no authority rule resolves the disagreement, use `Conflict` and cite each source. Do not choose a winner.
- If the repository explicitly removes or changes a declaration, update/remove the old generated repository fact in the candidate. The PR diff must show the removal. Describe only what changed in repository evidence; do not infer real-world teardown.
- Manual values and notes are not subject to automatic deletion. If they conflict with new evidence, preserve and flag them for human review.
- Do not create a proposal if evidence processing or the DEC-04 secret/output scan is incomplete or unsafe.

## 6. Fixed Template Protection

The DEC-05 `technical-profile.md` contract remains authoritative:

1. Application Name
2. Description
3. Primary Language / Runtime
4. Frameworks and Libraries
5. Dependencies
6. Database / Data Stores
7. APIs and Integrations
8. Configuration / Environment Variables
9. Build and Test
10. CI/CD
11. Deployment / Infrastructure
12. Security
13. Logging and Monitoring
14. Repository / Branch
15. Limitations / Missing Information
16. Evidence / Verification Status

The generated marker, each required field, the section order, and the final evidence ledger are mandatory. Generated ownership comments wrap each section's system-owned table without changing the visible headings or table fields. The evidence ledger uses current deterministic evidence IDs and sanitized source paths/keys. All profile paths/locators and values remain subject to DEC-04 redaction and scanning.

Manual `###` subsections are permitted only outside generated blocks and under the existing fixed H2 section; preserve them verbatim and retain their relative placement. Do not add, delete, rename, or reorder top-level sections during reconciliation. Unexpected top-level sections or a broken required table make the profile malformed/unclassified and block automated reconciliation. Human review may propose a corrected structure, but the reconciler does not silently normalize away the unexpected content.

## 7. First Generation and Review Diff

When no root-level `technical-profile.md` exists, render all 16 sections and every required field from the DEC-05 template. Use `Not Specified` when no eligible evidence exists, `Unable to Verify` when evidence exists but cannot be verified, and `Conflict` when credible evidence disagrees. Add the generated marker and ownership/digest comments to generated tables; add the evidence ledger. Run the full DEC-04 scan and DEC-05 completeness/consistency gate before the DEC-03 proposal job.

For an existing valid profile, the candidate contains refreshed generated blocks plus verbatim manual subsections. The proposal diff must expose generated additions, modifications, and removals and preserve manual material. A no-op candidate creates no PR. No candidate is written to the target's default branch before human review and approved merge.

## 8. Malformed or Unsafe Existing Profile

Treat any of the following as unsafe for automatic reconciliation: secret-like content in the existing profile; DEC-04 size-limit breach; invalid UTF-8; parse failure; missing/invalid global or per-section marker; digest mismatch; unknown schema; unexpected/misordered H2; missing/duplicate required fields; malformed table; or ambiguous generated/manual ownership.

In these cases:

- Preserve the existing approved file byte-for-byte in the target repository.
- Do not generate a replacement proposal or PR and do not create a branch.
- Report a sanitized reason and flag the profile for human review; never echo secret values or snippets.
- Allow a later rerun after a human resolves the marker/schema/format issue. Do not automatically migrate legacy profiles, discard unexpected content, or use Git history to guess ownership.

The same preservation rule applies to generation, scanner, validator, test-gate, and proposal failures. The last approved profile remains unchanged.

## 9. Security, Validation, and Tests

- Validate all ownership markers, digests, required fields, headings, section order, field/table schemas, evidence references, statuses, and deterministic ordering before proposal handoff.
- Scan the existing profile before parsing/reconciliation and scan the complete candidate afterward using the DEC-04 process. Any sensitive finding or uncertain output blocks handoff; diagnostics contain only sanitized metadata.
- Ensure the proposal contains only the reconciled `technical-profile.md` change and review-safe status text. It must not include source snippets, secrets, credentials, or unrelated files.
- Automated tests use synthetic, nonfunctional secret-shaped fixtures only. Cover unchanged/update/add/remove/conflict/missing/unverifiable fields; marker/hash validation; manual-subsection preservation; malformed/legacy profiles; stable rendering; and failure preservation.
- Test that gate failure, scanner failure, malformed profile, or unsafe reconciliation prevents branch/PR creation and leaves the existing approved profile unchanged.

## 10. Alternatives and Trade-offs

- **Overwrite the whole profile every run:** Simple but risks deleting manually maintained content; rejected.
- **Never update existing profiles automatically:** Safest for manual text but does not keep generated information current; rejected for valid marker-managed generated blocks.
- **Infer ownership from the global generated marker or Git history:** Ambiguous and conflicts with DEC-04's no-history analysis boundary; rejected.
- **Use hidden per-section ownership markers and content digests:** Enables safe refresh of unchanged machine-owned blocks while detecting edits; selected. It adds metadata to Markdown source and requires legacy/manual resolution, but does not change visible section order or rendered template structure.
- **Allow manual subsections outside generated blocks:** Preserves human notes while maintaining required fields; selected with fixed H2 sections and stable placement. Unclassified or malformed top-level content blocks automated proposal rather than being moved or deleted.

## 11. Impact on Implementation Tasks

- **IMP-05:** Read the existing profile before composition; enforce DEC-04 size/encoding/secret checks and preserve the original snapshot for failure safety.
- **IMP-09:** Render the exact DEC-05 16-section template and per-section generated markers/digests for new profiles.
- **IMP-10:** Parse and validate ownership markers, hashes, required schema, and human-maintained subsections; reconcile only verified generated blocks; preserve/flag manual or unclassified content.
- **IMP-11:** Validate field/status/evidence contracts, fixed headings/order, marker integrity, conflict handling, and safe output.
- **IMP-12 / IMP-13:** Test field reconciliation, manual preservation, visible diffs, malformed/legacy profiles, secret findings, failure preservation, deterministic output, and fail-closed gate behavior before proposal credentials are released.
- **IMP-14:** Create a PR only after the full gate succeeds; include only the reconciled profile change. Human approval remains required by DEC-03.
- **IMP-17:** Verify first generation and existing-profile cases, including legacy/unclassified/malformed profiles and safe failure behavior, against an authorized test repository.

## 12. DEC-06 Status

**READY FOR APPROVAL**