# Changelog

## Unreleased

- Implemented single-repository analysis and deterministic `technical-profile.md` generation with evidence traceability and safe reconciliation of generated and human-maintained content.
- Added fail-closed validation, pinned local Gitleaks scanning, sensitive-file/value handling, and a gated feature-branch Pull Request proposal flow for human review; no direct default-branch publication is performed.
- Added unit and integration coverage for profile quality, security controls, failure preservation, proposal safety, and repeatability. Final local verification passed 213 tests, typecheck, build, npm audit, and `git diff --check`; live GitHub behavior and Maven auditing remain unverified.
