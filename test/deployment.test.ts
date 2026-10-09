import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type WorkflowStep = {
  name?: string;
  env?: Record<string, string>;
  run?: string;
};

type WorkflowJob = {
  needs?: string | string[];
  environment?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

test("keeps proposal credentials behind a successful read-only validation job", async () => {
  const contents = await readFile(resolve(process.cwd(), ".github/workflows/docs-sync.yml"), "utf8");
  const workflow = parse(contents) as {
    on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
    concurrency?: { group?: string; "cancel-in-progress"?: boolean };
    permissions?: Record<string, string>;
    jobs?: Record<string, WorkflowJob>;
  };
  const validation = workflow.jobs?.["validate-target"];
  const proposal = workflow.jobs?.["propose-change"];
  assert.ok(validation);
  assert.ok(proposal);
  assert.equal(workflow.on?.workflow_dispatch?.inputs?.target_repository?.required, true);
  assert.match(workflow.concurrency?.group ?? "", /inputs\.target_repository/);
  assert.equal(workflow.concurrency?.["cancel-in-progress"], false);
  assert.equal(workflow.permissions?.contents, "read");
  assert.equal(proposal.permissions?.contents, "read");
  assert.equal(proposal.needs, "validate-target");
  assert.equal(proposal.environment, "docs-sync-proposal");
  assert.equal(validation["timeout-minutes"], 15);
  assert.equal(proposal["timeout-minutes"], 15);

  const validationStep = validation.steps?.find((step) => step.name === "Validate target configuration");
  const proposalStep = proposal.steps?.find((step) => step.name === "Revalidate and create review proposal");
  assert.equal(validation.steps?.find((step) => step.name === "Build CLI and test suite")?.run, "npm run build");
  assert.equal(proposal.steps?.find((step) => step.name === "Build CLI and test suite")?.run, "npm run build");
  assert.match(validationStep?.run ?? "", /--validate-only/);
  assert.equal(validationStep?.env?.DOCS_SYNC_AUTOMATED_TESTS_PASSED, undefined);
  assert.equal(validationStep?.env?.DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY, undefined);
  assert.equal(proposalStep?.env?.DOCS_SYNC_AUTOMATED_TESTS_PASSED, undefined);
  assert.equal(proposalStep?.env?.DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED, "\${{ vars.DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED }}");
  assert.equal(proposalStep?.env?.DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY, "\${{ secrets.DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY }}");
});
