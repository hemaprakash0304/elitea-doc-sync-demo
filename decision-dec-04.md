# DEC-04: File Exclusions, Sensitive Content Handling, Secret Scanning, and Processing Boundary

## 1. Decision

**Status: READY FOR APPROVAL**

Analyze only bounded, allowlisted UTF-8 text and GitHub metadata from the single configured repository's current default branch. Apply path/type/size exclusions before analysis. Do not follow symlinks, fetch submodules, inspect Git history, or access other repositories or external systems.

Run the open-source Gitleaks scanner locally in the authorized runner/CLI environment, with pinned rules/tool version, full finding redaction, and no external SaaS upload. Also apply deterministic path, file-type, and output checks. Never pass excluded files or secret values into evidence, generation, logs, artifacts, PR content, or `technical-profile.md`.

A detected secret-like value in an otherwise eligible source file excludes that entire file and records only a sanitized finding; analysis may continue with remaining sources and must mark affected profile fields missing/unverifiable. A finding in the existing `technical-profile.md`, any finding in the generated candidate, incomplete scan coverage, or scanner failure blocks the gate and proposal. The last approved profile remains unchanged.

## 2. Options Considered

| Option | Advantages | Trade-offs | Decision |
|---|---|---|---|
| Deterministic path/type rules only | Small and predictable; avoids scanning known sensitive paths. | Misses credentials accidentally committed in ordinary source/configuration files. | Insufficient alone. Use as the first filter and pair with content scanning. |
| Local open-source Gitleaks plus deterministic rules | Detects common credential patterns locally; no repository content sent to a scanning SaaS; findings can be redacted. | False positives require excluding files or a reviewed rule change; scanning adds time and needs a pinned tool. | **Recommended.** Run only on bounded eligible text and on the proposed profile. |
| External secret-scanning SaaS | Could provide centralized detection and managed rules. | Sends private repository content outside the approved processing boundary and adds a service dependency. | Reject for the initial version. |
| Run analyzers first and scan only generated Markdown | Simpler data flow. | Secrets could enter intermediate evidence or generation context before output scanning. | Reject. Scan eligible inputs before analysis and scan output before handoff. |

The scanner is a local tool dependency, not an information source. No scanner service, cloud environment, package registry, or deployment environment receives repository content.

## 3. File Inclusion Policy

Only regular, non-binary, UTF-8 text files from the selected target's current default-branch snapshot may be considered. Path and file-type filtering occurs before content is read for analysis; eligible content is secret-scanned before it is passed to analyzers or composition.

| Include when not excluded | Examples |
|---|---|
| Documentation and project text | `README*`, `*.md`, `*.rst`, `*.adoc`, selected `LICENSE`/`NOTICE` text. |
| Initial source types | Java `*.java`; Node.js `*.js`, `*.jsx`, `*.mjs`, `*.cjs`, `*.ts`, `*.tsx`; relevant `*.sh`/`*.ps1` build/test scripts (inspect only; never execute). |
| Dependency/build manifests | `pom.xml`, `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, and relevant non-secret text build/config manifests. |
| Deployment/workflow/configuration text | `Dockerfile*`, `docker-compose*.yml`/`*.yaml`, `.dockerignore`, `.github/workflows/*.yml`/`*.yaml`, and eligible `*.json`, `*.yaml`, `*.yml`, `*.toml`, `*.xml`, `*.properties`, `*.ini`, `*.cfg`, `*.conf`, `*.tf`, `*.hcl`, and schema/migration `*.sql`. |

The following are excluded by default, case-insensitively, at any depth unless otherwise stated:

- **Version-control internals and unrelated repositories:** `.git/**`, `.hg/**`, `.svn/**`, `.bzr/**`, `.gitmodules`, and all Git history. Do not fetch or traverse submodule contents; report only a sanitized relative path that a submodule was omitted.
- **Environment and credential files:** `.env` and `.env.*` (including examples/templates), `*.env`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `settings.xml`, `credentials`/`credentials.*`, `secrets`/`secrets.*`, and credential/secret directories.
- **Keys, certificates, and credential stores:** `.ssh/**`, `.aws/**`, `.azure/**`, `.kube/**`, `.config/gcloud/**`, `.docker/config.json`, `known_hosts`, `authorized_keys`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`, and files ending `.key`, `.pem`, `.p8`, `.p12`, `.pfx`, `.ppk`, `.der`, `.crt`, `.cer`, `.p7b`, `.p7c`, `.jks`, `.keystore`, `.kdbx`, `.asc`, or `.gpg`. Exclude certificates as well as private keys to avoid client identity or embedded sensitive material.
- **Generated/build/dependency/vendor content:** `node_modules/**`, `bower_components/**`, `jspm_packages/**`, `vendor/**`, `third_party/**`, `third-party/**`, `external/**`, `Pods/**`, `target/**`, `build/**`, `dist/**`, `out/**`, `bin/**`, `obj/**`, `.gradle/**`, `.mvn/wrapper/dists/**`, `.next/**`, `.nuxt/**`, `.output/**`, `coverage/**`, `.nyc_output/**`, `.terraform/**`, and directories named `generated`, `generated-sources`, or `generated-resources`.
- **Logs, caches, temporary files, backups, and data dumps:** `log/**`, `logs/**`, `cache/**`, `caches/**`, `.cache/**`, `tmp/**`, `temp/**`, `backup/**`, `backups/**`, `dumps/**`, `exports/**`, `*.log*`, `*.trace`, `*.dump`, `*.dmp`, `*.core`, `*.cache`, `*.tmp`, `*.bak`, `*.old`, `*.sql.gz`, `*.csv`, `*.tsv`, `*.jsonl`, and editor swap files.
- **Binaries and generated/minified artifacts:** Known binary/archive/media/object formats; `*.class`, `*.jar`, `*.war`, `*.ear`, `*.zip`, `*.tar`, `*.gz`, `*.7z`, `*.rar`, `*.exe`, `*.dll`, `*.so`, `*.dylib`, `*.o`, `*.a`, `*.map`, and `*.min.js`. Also exclude any file detected as binary by content (including NUL bytes) or not safely decodable as UTF-8.
- **Symlinks and special entries:** Never follow symlinks or read device/special files. Omit them and report sanitized relative paths/counts only.

**Resource limits:** Maximum 2 MiB per eligible file, 20 MiB total eligible text per run, and 5,000 eligible files per run. Process paths in stable sorted order. Exceeding a limit excludes the affected file(s) and marks analysis incomplete; if `technical-profile.md` itself exceeds the per-file limit, stop before reconciliation and preserve it unchanged. These caps bound scan time and memory for the approximately five-minute small-to-medium-repository target.

## 4. Sensitive/Secret Exclusion Policy

- Excluded paths and files are not read into evidence, analyzers, prompts, or generated documentation. Path exclusions take precedence over extension-based inclusion.
- Scan each eligible text file before analysis. If a secret-like match occurs in an eligible source/configuration file, exclude the entire file rather than attempting line-level redaction; record only sanitized relative path, line number if safe, and rule identifier. Do not preserve matching snippets or values.
- Continue with remaining eligible sources when safe. Mark facts that depended on the excluded file `Not Specified` if evidence is absent, `Unable to Verify` if verification is impaired, and identify the profile as incomplete through the agreed field/status mechanism.
- If a finding occurs in the existing `technical-profile.md`, do not pass that profile to reconciliation or produce a replacement proposal. Stop the run, report a sanitized failure, and leave the approved profile unchanged.
- Environment variables are documented by name only. Never read an environment-variable value for profile generation or include a value in the profile, evidence, PR, or diagnostics.
- Do not inspect secrets stored in excluded files; exclusion is the protection boundary. No rule may permit a credential file to be included merely because it is considered an example.

## 5. Secret Detection

Use a pinned, open-source Gitleaks release in local directory-scanning mode, configured to scan only the eligible current-snapshot text set and the final candidate. Do not scan Git history or make SaaS/network calls with repository contents. Use Gitleaks' built-in rules plus deterministic custom rules for private-key headers and common credential/token assignments and formats. Full redaction is required for scanner output; consume only sanitized rule/path/line metadata.

- **Input finding:** Exclude the entire affected file and record a sanitized incomplete-analysis finding. Continue only if scanning completed for all remaining eligible files and the final output gate passes.
- **Candidate/output finding:** Fail validation. No branch or PR is created; report only a sanitized rule/location and keep the approved profile unchanged.
- **Uncertain match:** Treat it as sensitive. Exclude the input file; never downgrade or suppress it dynamically during a run. If uncertainty is in the candidate or existing profile, fail closed.
- **False positives:** The default response is file exclusion and sanitized reporting, not emission. A recurring false positive may be addressed only by a reviewed scanner-rule/configuration change with a safe synthetic regression test and documented rationale. No per-run ignore flag or broad path suppression is allowed.
- **Scan failure or incomplete coverage:** Treat as validation failure; do not hand off a proposal. Report scanner unavailable, timeout, parse error, or coverage failure without exposing file content.

The scanner version and custom rule set are pinned for reproducibility. No real credential is used to test a rule or placed in committed fixtures.

## 6. Processing Boundary

The only information sources are GitHub metadata and eligible content from the one selected repository's current default-branch snapshot. Analysis does not read other branches or history, unrelated repositories, submodule contents, package registries, cloud accounts, deployment systems, or external collaboration/documentation systems.

The authorized local CLI or GitHub-hosted runner performs filtering, scanning, analysis, reconciliation, composition, and validation. Repository contents and scan results are not sent to an external model, secret-scanning SaaS, or telemetry service. The GitHub REST API is used only for the selected repository metadata/content and the separately authorized proposal operations after the gate. Copilot Agent Mode is a capstone development aid, not a runtime content-processing service under this decision.

## 7. Output Safety

- Run the same secret scanner and deterministic sensitive-value checks against the fully composed and reconciled `technical-profile.md` before proposal handoff.
- Any output finding, scanner error, incomplete scan, or inability to verify output safety fails the validation gate. The output is not proposed or written to the target repository.
- Environment-variable names may appear; values, credentials, tokens, passwords, private keys, and connection-string secrets may not.
- Sanitized scan findings may identify a relative path, rule category, and line number only when those details do not themselves disclose sensitive data. Never include a match, snippet, request body, token-bearing URL, or raw scanner report.
- Only a clean, gate-approved profile diff may be handed to the DEC-03 proposal job. The approved profile remains unchanged until human review and merge.

## 8. Failure Behavior

| Condition | Required behavior |
|---|---|
| Excluded sensitive path/file | Do not read or analyze it; record a sanitized omission if relevant. Continue with other allowed sources. |
| Secret-like match in an eligible source file | Exclude the whole file, report a sanitized finding, mark dependent profile fields missing/unverifiable, and continue only if remaining scans complete and output validation passes. |
| Secret-like match in existing `technical-profile.md` | Stop reconciliation and proposal; preserve the existing approved file byte-for-byte and report a sanitized security failure. |
| Candidate contains a secret or sensitive value | Fail the gate; do not write, branch, or create a PR; preserve approved documentation. |
| Scanner missing, crashing, timing out, or unable to scan an eligible file/output | Fail the gate closed; no proposal/PR; preserve approved documentation. |
| File/aggregate/count limit exceeded | Exclude unprocessed content, report incomplete coverage, and use required missing/unverifiable labels. Do not claim facts from excluded content. |
| Symlink, submodule, binary, or unsupported encoding | Do not follow/read it; report omission without including its contents or external URL. |
| Any scan or generation failure | Do not modify the target's approved `technical-profile.md`; report safe diagnostics and allow recovery by rerunning after the issue is resolved. |

## 9. Security Tests

Use only safe, synthetic fixtures. Generate test inputs at runtime in temporary directories outside the target repository snapshot, then remove them. Never use production credentials, copied tokens, real private keys, or live customer data.

Test at least:

- Each path exclusion and file-type rule, including `.env*`, credential files, key/certificate containers, VCS metadata, generated/vendor/build directories, logs/caches, binaries, and data dumps.
- Allowlisted README, Java/Maven, Node.js/package-lock, Docker, GitHub Actions, and configuration examples are scanned before analysis and remain usable when clean.
- Synthetic credential-shaped strings and a dummy private-key header are detected and fully redacted; test values are deliberately nonfunctional and marked `SYNTHETIC_ONLY`.
- A detected source-file match excludes the whole file and yields only sanitized finding metadata; an existing-profile match stops reconciliation and preserves that file.
- Output matches, scanner failure, timeout, unreadable eligible files, or incomplete coverage block branch/PR handoff.
- Symlinks and submodule entries are not followed or fetched; limits are deterministic and produce incomplete-analysis statuses.
- Clean output contains no values for environment variables or secrets, and diagnostics/PR descriptions do not contain scanner snippets or credentials.

## 10. Risks and Mitigations

- **False positives reduce profile completeness:** Exclude the entire affected source file, identify the omission without exposing values, and allow only narrow, reviewed rule changes backed by safe tests.
- **False negatives remain possible:** Combine Gitleaks built-in rules, deterministic custom patterns, path exclusions, and a final output scan; do not claim the scanner proves the repository has no secrets.
- **Scanning limits omit useful evidence:** Apply stable ordering and explicit size/count caps; mark incomplete areas rather than guessing. Measure the configured caps against the five-minute target during DEC-08/acceptance testing.
- **Scanner output leaks matches:** Require full redaction, parse only sanitized metadata, suppress raw command output, and test log/artifact paths.
- **External processing exposes private content:** Keep scanning and analysis local to the authorized runner/CLI; no SaaS or external model receives repository contents.
- **Rules drift or broad suppressions weaken coverage:** Pin scanner/rules, review updates, test synthetic detections, and prohibit run-time ignore switches.
- **Secrets in existing profile prevent reconciliation:** Fail safely and preserve the approved profile; require human remediation outside the generated proposal path.

## 11. Impact on Implementation Tasks

- **DEC-04:** This decision sets path/type/size rules, Gitleaks-based local scanning, secret-finding behavior, local processing boundaries, and fail-closed output validation.
- **IMP-05 / IMP-06:** Apply path/type/size filtering before analysis; never follow symlinks or fetch submodules; materialize only the selected target's current default branch.
- **IMP-07 / IMP-08:** Analyze only allowlisted clean text; attach sanitized evidence/status and identify exclusions without recording values.
- **IMP-10:** Stop if the existing `technical-profile.md` contains a secret-like finding; preserve it unchanged.
- **IMP-11 / IMP-12 / IMP-13:** Scan eligible input before analyzers, scan output after reconciliation, cover synthetic fixtures, and fail the validation/test gate on scanner failure or unsafe output before proposal credentials are available.
- **IMP-15 / IMP-16 / IMP-17:** Emit sanitized diagnostics, protect processing credentials/content, and verify the exclusions, scan-failure behavior, output safety, and performance limits end to end.
- DEC-04 does not change DEC-02 read access or DEC-03 write/PR permissions; the proposal credential remains isolated and is not used for reading/scanning.

## 12. DEC-04 Status

**READY FOR APPROVAL**
