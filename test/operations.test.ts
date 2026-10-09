import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPERATIONAL_LIMITS,
  resolveOperationalLimits,
  tryAcquireProposalRunLock,
} from "../src/operations.js";

test("defines finite conservative operational defaults and clamps overrides", () => {
  assert.deepEqual(DEFAULT_OPERATIONAL_LIMITS, {
    overallRunTimeoutMs: 600_000,
    scannerTimeoutMs: 30_000,
    proposalOperationTimeoutMs: 30_000,
    maxProposalRunsPerTarget: 1,
  });
  assert.deepEqual(resolveOperationalLimits({
    overallRunTimeoutMs: Number.POSITIVE_INFINITY,
    scannerTimeoutMs: 0,
    proposalOperationTimeoutMs: 99_999_999,
  }), {
    overallRunTimeoutMs: 600_000,
    scannerTimeoutMs: 100,
    proposalOperationTimeoutMs: 1_800_000,
    maxProposalRunsPerTarget: 1,
  });
});

test("fails fast for a concurrent target proposal run and releases the lock on completion", () => {
  const release = tryAcquireProposalRunLock("Sample/Operational-Fixture");
  assert.equal(typeof release, "function");
  assert.equal(tryAcquireProposalRunLock("sample/operational-fixture"), undefined);
  release?.();
  assert.equal(typeof tryAcquireProposalRunLock("sample/operational-fixture"), "function");
  tryAcquireProposalRunLock("sample/operational-fixture")?.();
});