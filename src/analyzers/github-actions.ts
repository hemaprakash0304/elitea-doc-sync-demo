import YAML from "yaml";
import { createObservation, containsSensitiveValue } from "./observation.js";
import type {
  AnalyzerInput,
  AnalyzerIssue,
  AnalyzerOutput,
  TechnicalObservation,
  TechnologyAnalyzer,
} from "./types.js";

export class GitHubActionsAnalyzer implements TechnologyAnalyzer {
  readonly id = "github_actions" as const;

  analyze(input: AnalyzerInput): AnalyzerOutput {
    const observations: TechnicalObservation[] = [];
    const issues: AnalyzerIssue[] = [];
    for (const file of [...input.files].sort((left, right) => compareText(left.path, right.path))) {
      if (!/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file.path)) {
        continue;
      }
      analyzeWorkflow(file.path, file.content, observations, issues);
    }
    return { observations, issues };
  }
}

function analyzeWorkflow(
  path: string,
  content: string,
  observations: TechnicalObservation[],
  issues: AnalyzerIssue[],
): void {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content, { uniqueKeys: true, maxAliasCount: 0, schema: "core" });
  } catch {
    issues.push({ analyzer: "github_actions", code: "INVALID_YAML", path });
    return;
  }
  const workflow = asRecord(parsed);
  if (workflow === undefined) {
    issues.push({ analyzer: "github_actions", code: "INVALID_YAML", path });
    return;
  }

  const workflowName = stringValue(workflow.name);
  if (workflowName !== undefined) {
    emit(observations, {
      analyzer: "github_actions",
      category: "workflow_name",
      name: "Workflow name",
      value: workflowName,
      path,
      locator: "name",
      sourceKind: "workflow",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
  }

  for (const trigger of triggerNames(workflow.on)) {
    emit(observations, {
      analyzer: "github_actions",
      category: "workflow_trigger",
      name: "Workflow trigger declaration",
      value: trigger,
      path,
      locator: `on.${trigger}`,
      sourceKind: "workflow",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
  }
  emitEnvironmentNames(path, "workflow.env", workflow.env, observations);
  emitPermissions(path, "permissions", workflow.permissions, observations);

  const jobs = asRecord(workflow.jobs);
  if (jobs === undefined) {
    return;
  }
  for (const jobId of Object.keys(jobs).sort(compareText)) {
    const job = asRecord(jobs[jobId]);
    if (job === undefined) {
      continue;
    }
    const jobName = stringValue(job.name) ?? jobId;
    const jobLocator = `jobs.${jobId}`;
    emit(observations, {
      analyzer: "github_actions",
      category: "workflow_job",
      name: jobName,
      value: `declared job ${jobId}`,
      path,
      locator: jobLocator,
      sourceKind: "workflow",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
    emitPermissions(path, `${jobLocator}.permissions`, job.permissions, observations);
    emitEnvironmentNames(path, `${jobLocator}.env`, job.env, observations);

    for (const [stepIndex, stepValue] of asArray(job.steps).entries()) {
      const step = asRecord(stepValue);
      if (step === undefined) {
        continue;
      }
      const stepLocator = `${jobLocator}.steps[${stepIndex}]`;
      const stepName = stringValue(step.name) ?? `step ${stepIndex + 1}`;
      const action = stringValue(step.uses);
      if (action !== undefined) {
        emit(observations, {
          analyzer: "github_actions",
          category: "github_action",
          name: stepName,
          value: action,
          path,
          locator: `${stepLocator}.uses`,
          sourceKind: "workflow",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
      const command = stringValue(step.run);
      if (command !== undefined && !containsSensitiveValue(command) && !/\$\{\{\s*secrets\./i.test(command)) {
        emit(observations, {
          analyzer: "github_actions",
          category: "workflow_step",
          name: stepName,
          value: command,
          path,
          locator: `${stepLocator}.run`,
          sourceKind: "workflow",
          claimType: "declaration",
          verificationBasis: "structured_declaration",
          confidence: "High",
        });
      }
      emitEnvironmentNames(path, `${stepLocator}.env`, step.env, observations);
    }
  }
}

function triggerNames(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").sort(compareText);
  }
  const record = asRecord(value);
  return record === undefined ? [] : Object.keys(record).sort(compareText);
}

function emitPermissions(
  path: string,
  locator: string,
  value: unknown,
  observations: TechnicalObservation[],
): void {
  if (value === undefined) {
    return;
  }
  const permissions = asRecord(value);
  if (permissions === undefined) {
    const declaration = stringValue(value);
    if (declaration !== undefined) {
      emit(observations, {
        analyzer: "github_actions",
        category: "workflow_permission",
        name: "Workflow permission policy",
        value: declaration,
        path,
        locator,
        sourceKind: "workflow",
        claimType: "declaration",
        verificationBasis: "structured_declaration",
        confidence: "High",
      });
    }
    return;
  }
  for (const permission of Object.keys(permissions).sort(compareText)) {
    const access = stringValue(permissions[permission]);
    if (access === undefined) {
      continue;
    }
    emit(observations, {
      analyzer: "github_actions",
      category: "workflow_permission",
      name: permission,
      value: access,
      path,
      locator: `${locator}.${permission}`,
      sourceKind: "workflow",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
  }
}

function emitEnvironmentNames(
  path: string,
  locator: string,
  value: unknown,
  observations: TechnicalObservation[],
): void {
  const environment = asRecord(value);
  if (environment === undefined) {
    return;
  }
  for (const name of Object.keys(environment).sort(compareText)) {
    emit(observations, {
      analyzer: "github_actions",
      category: "workflow_environment_variable",
      name: "Workflow environment variable name",
      value: name,
      path,
      locator: `${locator}.${name}`,
      sourceKind: "workflow",
      claimType: "declaration",
      verificationBasis: "structured_declaration",
      confidence: "High",
    });
  }
}

function emit(output: TechnicalObservation[], input: Parameters<typeof createObservation>[0]): void {
  const observation = createObservation(input);
  if (observation !== undefined) {
    output.push(observation);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length === 0 ? undefined : text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}