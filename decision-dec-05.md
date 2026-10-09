# DEC-05: Analyzer Support, Evidence Model, and Technical Profile Template

## 1. Decision

**Status: READY FOR APPROVAL**

Use deterministic structured parsers for supported manifests and metadata, supplemented by narrow pattern-based observations from eligible source/configuration text and documentation. Keep AI out of the initial runtime analyzer: Copilot Agent Mode is a development aid. The renderer must use the exact 16-section Markdown template below, preserve stable field order, and attach traceable evidence/status to each field.

Only the approved repository snapshot and GitHub metadata are evidence sources. The implementation does not execute repository scripts or inspect external runtime environments. Claims describe what the repository declares or contains; they do not assert that a production deployment is running or configured accordingly.

## 2. Supported Technology Scope

| Area | Files examined from the DEC-04 allowlist | Facts that may be extracted | Not reliably determined |
|---|---|---|---|
| Java / Maven | `pom.xml`, `*.java`, Maven wrapper scripts/properties when eligible, README/build documentation | Declared Java source/release level, Maven modules only as repository facts (without per-service profiles), declared dependencies and scopes, build/test plugins and commands, source references to frameworks/APIs | Actual runtime/JDK used in production, resolved dependency versions if no lock/resolution evidence is present, runtime activation, deployed services, or behavior not explicit in repository evidence |
| JavaScript / Node.js | `package.json`, eligible package lockfiles, `*.js`, `*.jsx`, `*.mjs`, `*.cjs`, `*.ts`, `*.tsx`, README/build documentation | Declared package name/description, `engines.node`, direct dependency names/specifiers, lockfile-resolved versions, scripts, test tooling, imported framework/API references | Actual Node runtime in deployment, whether optional/platform-specific dependencies are installed, production activation, or runtime behavior not established by static files |
| Docker | `Dockerfile*`, `docker-compose*.yml`/`*.yaml`, `.dockerignore` | Declared base image, build stages, exposed ports, declared services/volumes/networks, build commands, referenced variable names | Running image contents, resolved mutable image tags, actual container deployment, secrets supplied at runtime, or infrastructure outside checked-in files |
| GitHub Actions | `.github/workflows/*.yml`/`*.yaml` | Workflow names, triggers, jobs, referenced actions, declared permissions, build/test/deploy steps and referenced variable names | Whether workflows ran successfully, secret values, repository settings not in files, deployment outcomes, or external service state |
| Markdown/documentation | Eligible `README*`, `*.md`, `*.rst`, `*.adoc`, selected text license/notices | Explicit project description, commands, stated integrations, and claims that can be cited | Uncorroborated claims about actual production configuration or behavior; documentation does not override conflicting authoritative manifests/configuration |
| Relevant configuration/dependencies | Eligible JSON/YAML/TOML/XML/properties/INI/config text, `pom.xml`, package manifests/lockfiles, Docker and workflow files, eligible SQL schema/migrations and infrastructure text | Declared settings, dependency constraints/locked versions, environment-variable names, schema/database technology references, and checked-in deployment declarations | Secret values, effective runtime values, external package registry state, cloud/deployment state, database contents, or configuration supplied outside the repository |

Initial support is limited to the formats above and parsers selected/maintained for those formats. Do not add other analyzers merely because a file is detectable. When an unsupported technology is safely named in an eligible file, record the observed name as an unsupported/unverified item and continue analyzing supported sources; do not claim full support for it.

## 3. Analyzer Architecture

1. **Snapshot and metadata:** Use the GitHub metadata/current-default-branch snapshot established by DEC-01/02. Analyze one repository state only; do not read Git history or other branches.
2. **DEC-04 filtering and scanning:** Apply path/type/size exclusions before reading content. Scan eligible text locally before parsing or pattern analysis. Exclude a file with a secret-like finding and never pass its content or snippets to later stages.
3. **Deterministic structured extraction:** Parse supported JSON, XML, YAML, properties, and lock/manifest structures into typed facts. Extract GitHub repository/default-branch data from GitHub metadata. Preserve the source locator for each fact.
4. **Narrow pattern extraction:** Recognize only explicitly defined source/configuration patterns (for example, environment-variable names, imports, route declarations, or logging library references). These establish repository observations, not verified runtime behavior.
5. **Documentation claims:** Extract/cite direct README or documentation claims as documentation-sourced evidence. Treat them as lower authority than applicable structured manifests/configuration.
6. **Evidence resolution and rendering:** Normalize and sort facts, retain competing credible claims as `Conflict`, then render the template deterministically. Never fill missing data by inference.
7. **Output validation:** Apply the required-field/status checks and DEC-04 secret scan to the fully reconciled candidate before the DEC-03 proposal job.

A source fact is **observed** when a parser or pattern identifies it in an eligible repository file or GitHub metadata. It is **inferred** if it requires an unstated assumption. Inferred statements are not emitted as facts. If useful, an interpretation may be phrased only as a clearly labeled, evidence-linked note and must not replace a required field's verification status.

Source authority is field-specific. GitHub metadata is authoritative for repository identity/default branch; a dependency lockfile is authoritative for its resolved package version while the manifest remains evidence for the declared constraint; Maven/package manifests and checked-in configuration outrank README claims when they clearly define the same field. If authority is unclear or credible sources disagree, use `Conflict` and show both evidence references rather than silently choosing.

## 4. Evidence Model

Each evidence record contains:

| Field | Meaning |
|---|---|
| Evidence ID | Stable reference such as `E001`, assigned deterministically by profile section, field, source path, and locator. |
| Profile field | Exact section/field the record supports or conflicts with. |
| Source type | GitHub metadata, Maven manifest, package manifest/lockfile, Docker, workflow, source pattern, or documentation. |
| Source locator | Sanitized repository-relative path plus line range when safely available; otherwise a structured key/section locator. GitHub facts use the metadata key and analyzed ref/commit. |
| Extracted fact | Minimal normalized fact needed for the profile, never a raw snippet or secret-bearing value. |
| Evidence status | One of `Verified`, `Not Specified`, `Unable to Verify`, or `Conflict`. |
| Verification basis | Deterministic structured declaration, direct source pattern, documentation claim, GitHub metadata, or no eligible evidence. |
| Confidence | `High` for authoritative structured declarations/metadata; `Medium` for direct source/config patterns or corroborated documentation; `Low` for weak/indirect claims. Low-confidence claims cannot be presented as verified facts and are labeled `Unable to Verify` or omitted from factual summaries. |

Status semantics:

- **Verified:** The stated fact is directly observed in an eligible source or GitHub metadata. This verifies the repository declaration, not live production state.
- **Not Specified:** No eligible repository evidence was found for the field. The field remains present with the literal value `Not Specified`.
- **Unable to Verify:** Some evidence exists, but the source is unsupported, excluded, inaccessible, ambiguous, or too weak to verify the claim. Do not infer a replacement value.
- **Conflict:** Two or more credible sources disagree. Preserve references to each claim and do not choose a value unless the approved field-specific authority rule clearly resolves it.

A field may reference multiple evidence IDs. Every factual profile value must link to at least one evidence ID; missing fields receive a ledger record explaining that no eligible evidence was found. No evidence record may contain credentials, secret values, sensitive snippets, or raw API responses.

## 5. Technical Profile Template

The generated document has a title, the fixed generated marker below, and exactly these numbered sections in this order. Each field uses the standard `Value`, `Status`, and `Evidence IDs` columns. Emit one row per value when multiple values are allowed. Emit a row with `Not Specified` when no eligible evidence exists.

```markdown
# Technical Profile

<!-- Automatically generated. Values describe repository evidence and are not runtime validation. -->

## 1. Application Name
| Field | Value | Status | Evidence IDs |
|---|---|---|---|
| Application Name | Not Specified | Not Specified | — |

## 2. Description
| Field | Value | Status | Evidence IDs |
|---|---|---|---|
| Description | Not Specified | Not Specified | — |

## 3. Primary Language / Runtime
| Field | Value | Status | Evidence IDs |
|---|---|---|---|
| Primary language | Not Specified | Not Specified | — |
| Runtime(s) | Not Specified | Not Specified | — |

## 4. Frameworks and Libraries
| Framework/Library | Declared or observed version | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 5. Dependencies
| Dependency | Scope | Declared version/specifier | Lockfile-resolved version | Status | Evidence IDs |
|---|---|---|---|---|---|
| Not Specified | Not Specified | Not Specified | Not Specified | Not Specified | — |

## 6. Database / Data Stores
| Technology | Repository evidence/role | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 7. APIs and Integrations
| API/Integration | Observed repository reference | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 8. Configuration / Environment Variables
| Variable name | Evidence-backed purpose, if specified | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 9. Build and Test
| Category | Tool/framework/command | Status | Evidence IDs |
|---|---|---|---|
| Build tool | Not Specified | Not Specified | — |
| Build command(s) | Not Specified | Not Specified | — |
| Test framework | Not Specified | Not Specified | — |
| Test command(s) | Not Specified | Not Specified | — |

## 10. CI/CD
| Workflow/job/trigger/step | Repository declaration | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 11. Deployment / Infrastructure
| Declared component/resource | Repository declaration | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 12. Security
| Observed security configuration/control | Repository declaration | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 13. Logging and Monitoring
| Library/configuration/reference | Repository declaration | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 14. Repository / Branch
| Field | Value | Status | Evidence IDs |
|---|---|---|---|
| Repository | Not Specified | Not Specified | — |
| Default branch | Not Specified | Not Specified | — |
| Analyzed commit/ref | Not Specified | Not Specified | — |

## 15. Limitations / Missing Information
| Limitation or missing field | Safe explanation | Status | Evidence IDs |
|---|---|---|---|
| Not Specified | Not Specified | Not Specified | — |

## 16. Evidence / Verification Status
| Evidence ID | Profile field | Source type | Sanitized source locator | Extracted fact (sanitized) | Status | Verification basis | Confidence |
|---|---|---|---|---|---|---|---|
| E001 | Not Specified | Not Specified | Not Specified | No eligible evidence found | Not Specified | No eligible evidence | — |
```

The skeleton's example `Not Specified` rows are defaults, not fixed output. Replace each with evidence-backed values and IDs or retain the `Not Specified` row. Use `Unable to Verify` for inaccessible/unsupported evidence and `Conflict` for unresolved disagreements. Multiple values are allowed for language/runtime, frameworks/libraries, dependencies, data technologies, APIs/integrations, environment variables, commands, workflows, deployment declarations, security observations, logging/monitoring, limitations, and evidence records. Application name and description are single-value fields; repository/branch contains one value per metadata field.

## 6. Evidence-to-Profile Mapping

| Profile section | Expected evidence sources | Authority and limits |
|---|---|---|
| 1. Application Name | GitHub repository metadata; `package.json`; `pom.xml`; README title | Prefer repository metadata or canonical project manifest when clear. README is lower authority if it conflicts. |
| 2. Description | README/project documentation; `package.json` description; `pom.xml` description | Quote/paraphrase only an explicit claim and cite it. Conflicts remain `Conflict`; do not infer purpose from a repository name. |
| 3. Primary Language / Runtime | Source file types; `pom.xml` compiler/release settings; `package.json` engines; eligible build configuration | File extensions establish observed language, not deployed runtime. Runtime is `Unable to Verify` if not declared. |
| 4. Frameworks and Libraries | Maven/package manifests and lockfiles; direct imports/annotations in eligible source | Manifests are stronger than incidental imports; source patterns are labeled as observed references, not proof of production use. |
| 5. Dependencies | `pom.xml`; `package.json`; eligible Maven/npm lockfiles | Report declared direct runtime/dev dependencies. Lockfiles may supply resolved versions; do not invent versions or expand an unbounded transitive graph. |
| 6. Database / Data Stores | Dependency manifests, eligible configuration, SQL schema/migration files, Docker/compose declarations | Report repository declarations only; do not claim a live database or inspect data contents. |
| 7. APIs and Integrations | Eligible OpenAPI/GraphQL/proto/config files, routes/imports/calls in source, manifests, README | Cite observable declarations/references. A URL or library alone does not prove an active external integration. |
| 8. Configuration / Environment Variables | Eligible source/config/workflow/Docker files and build manifests | Extract names and explicitly documented purposes only. Never extract, cite, or emit values. `.env` and credential files are excluded by DEC-04. |
| 9. Build and Test | `pom.xml`, `package.json` scripts, wrapper/config files, workflow steps, README | Prefer executable declarations in manifests/workflows over README claims. Commands are inspected, never executed during analysis. |
| 10. CI/CD | `.github/workflows/*.yml` and `*.yaml` | Describe declared workflow/jobs/triggers/steps; do not claim a workflow ran successfully or reveal secret names/values beyond safe variable names. |
| 11. Deployment / Infrastructure | Dockerfiles, compose files, eligible `*.tf`/`*.hcl`, workflow deployment steps | Describe checked-in declarations only. No cloud accounts, deployment consoles, package registries, or live infrastructure are queried. |
| 12. Security | Workflow permissions, dependency/config declarations, source/config references | State only observable controls. Do not label the application secure, compliant, or vulnerability-free. |
| 13. Logging and Monitoring | Dependency manifests, source imports/usages, eligible config/workflow files | Identify repository references, not actual production telemetry or service health. |
| 14. Repository / Branch | GitHub repository metadata and analyzed snapshot/ref | Metadata is authoritative for repository identity/default branch. Do not include credentials in URLs. |
| 15. Limitations / Missing Information | Evidence coverage results, unsupported/excluded-source summary, conflicts | Summarize omissions safely; never identify a secret value or reproduce a sensitive snippet. |
| 16. Evidence / Verification Status | Evidence catalog for all fields and claims | Every factual value maps to one or more evidence IDs and sanitized locators. |

When README/documentation conflicts with a clearly applicable manifest or GitHub metadata, use the authoritative source for the relevant field and record the lower-authority discrepancy in Limitations/Evidence. When authority is not clear, use `Conflict` and present all supporting evidence IDs without choosing a winner.

## 7. AI/Copilot Role

- Initial runtime analysis and rendering are deterministic: structured parsing, safe pattern extraction, evidence/status assignment, and template rendering.
- Copilot Agent Mode is used as the capstone development aid, not as a runtime scanner or an authority for repository facts.
- If a separately approved, authorized in-boundary AI is later used, it may summarize already sanitized, verified evidence, organize it into the template, identify candidate conflicts, and explain relationships among cited facts. It must not receive excluded files, raw secret scan findings, secret values, raw repository contents through an external service, or private content outside the authorized workflow.
- AI output is not evidence. Every generated factual statement must link to deterministic evidence and pass the validator. AI may not invent versions, infrastructure, production behavior, APIs, databases, deployments, or security controls. Missing evidence remains `Not Specified`/`Unable to Verify`; conflicts remain `Conflict`.

## 8. Unsupported Technologies

If an unsupported technology is safely named in an eligible manifest, source file, configuration, or documentation, identify only the observed name and source. Mark details that cannot be parsed or verified `Unable to Verify`, list the limitation in Section 15, and continue analyzing supported evidence. Do not present the unsupported technology as fully analyzed, infer versions/capabilities, execute its tooling, or query its registry/runtime. Fields with no eligible evidence remain `Not Specified`.

## 9. Formatting, Traceability, and Safety

- Preserve the 16 numbered section headings and order exactly as shown. Keep all required fields present, including `Not Specified` defaults.
- Use Markdown tables with stable columns. Emit multiple rows for multiple values and evidence records; sort values and sources deterministically by section, field, normalized repository-relative path, and locator.
- Include the generated marker; omit generation timestamps so identical repository snapshots and policy versions produce stable output. Record the analyzed commit/ref under Repository / Branch.
- Assign evidence IDs in deterministic order (`E001`, `E002`, ...). Field rows cite IDs; the final Evidence section records each ID's profile field, source type, sanitized relative path or metadata key, line/key locator when safe, sanitized extracted fact, status, verification basis, and confidence.
- Use line ranges when safely available; otherwise use a structured locator such as a manifest key or GitHub metadata key. Never copy source snippets. Do not expose tokens, credentials, values, sensitive paths, raw API responses, or Gitleaks matches in profile evidence or diagnostics.
- Treat `Verified` as verified repository evidence, not proof of deployed/runtime behavior. `Not Specified` means no eligible evidence; `Unable to Verify` means evidence is unavailable/unsupported/ambiguous; `Conflict` means credible sources disagree.

## 10. Risks and Trade-offs

- **Static evidence cannot prove production state:** The profile describes repository declarations and observations only. This is intentionally narrower than inspecting cloud or deployment environments.
- **Pattern extraction can overstate relationships:** Keep source-pattern claims at Medium confidence, cite the exact locator, and avoid converting an import/URL into proof of active integration.
- **Unsupported or excluded files reduce completeness:** Mark affected fields and limitations rather than expanding scope or guessing.
- **Lockfile/manifest discrepancies:** Preserve declared and resolved versions separately; report conflicts instead of choosing without authority.
- **Deterministic output may be less narrative:** Prefer explicit facts and evidence over fluent but unsupported AI-generated prose; a later authorized AI role is conditional and must not weaken traceability.
- **Line locations can shift:** Use repository-relative paths and stable structured keys where possible; line locators are advisory and tied to the analyzed commit/ref.

## 11. Impact on Implementation Tasks

- **DEC-05:** This record establishes the initial analyzer scope, evidence/status contract, source authority, exact profile headings/order, and traceability/format rules.
- **IMP-07:** Implement deterministic parsers and narrow patterns only for the supported files/technologies; unsupported names are reported without full analysis.
- **IMP-08:** Implement the evidence record fields, status/confidence rules, conflict preservation, sanitized locators, and deterministic evidence IDs/order.
- **IMP-09:** Render the exact 16-section template with required fields, status notation, stable ordering, generated marker, and evidence links.
- **IMP-10:** Reconcile profile fields without discarding manual content; preserve the fixed template/order and make conflicts/removals visible.
- **IMP-11:** Validate every required field/status, source authority/conflict handling, output safety, and evidence references.
- **IMP-12 / IMP-13:** Test parsers, evidence mapping, deterministic rendering, unsupported-source behavior, false positives, and the pre-proposal gate. No test framework is selected here.
- **IMP-17:** Verify the full profile against safe fixtures for each supported technology and confirm deterministic output for the same snapshot/policy version.

## 12. DEC-05 Status

**READY FOR APPROVAL**
