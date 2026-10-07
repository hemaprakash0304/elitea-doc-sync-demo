import assert from "node:assert/strict";
import test from "node:test";
import type { RunConfiguration } from "../src/config.js";
import {
  collectRepositorySnapshot,
  RepositoryCollectionError,
  TECHNICAL_PROFILE_PATH,
  type CollectionErrorCode,
} from "../src/collection.js";
import type {
  GitHubBlob,
  GitHubCommitSnapshot,
  GitHubReadClient,
  GitHubRepositoryMetadata,
  GitHubRepositoryTree,
  GitHubTreeEntry,
} from "../src/github-client.js";
import { GitHubReadError } from "../src/github-errors.js";

const CONFIGURATION: RunConfiguration = {
  targetRepository: "Owner/Repo",
  normalizedRepositoryId: "owner/repo",
  executionContext: "local",
};

const REPOSITORY: GitHubRepositoryMetadata = {
  repositoryId: 7,
  normalizedRepositoryId: "owner/repo",
  fullName: "owner/repo",
  isPrivate: false,
  defaultBranch: "release/2026",
  readRetryCount: 0,
};

const SNAPSHOT: GitHubCommitSnapshot = {
  branch: "release/2026",
  commitSha: sha(1),
  treeSha: sha(2),
  readRetryCount: 0,
};

interface FakeClientOptions {
  entries?: GitHubTreeEntry[];
  contents?: Map<string, Uint8Array>;
  snapshot?: GitHubCommitSnapshot;
  tree?: GitHubRepositoryTree;
  failedBlobs?: Set<string>;
}

function sha(value: number): string {
  return value.toString(16).padStart(40, "0");
}

function textEntry(path: string, text: string, id: number): { entry: GitHubTreeEntry; bytes: Buffer } {
  const bytes = Buffer.from(text, "utf8");
  return {
    entry: {
      path,
      mode: "100644",
      type: "blob",
      sha: sha(id),
      size: bytes.length,
    },
    bytes,
  };
}

function createFakeClient(options: FakeClientOptions = {}): GitHubReadClient & { requestedBlobs: string[]; requestedBranches: string[]; requestedTrees: string[] } {
  const contents = options.contents ?? new Map<string, Uint8Array>();
  const requestedBlobs: string[] = [];
  const requestedBranches: string[] = [];
  const requestedTrees: string[] = [];
  const entries = options.entries ?? [];

  return {
    requestedBlobs,
    requestedBranches,
    requestedTrees,
    getRepositoryMetadata: async () => REPOSITORY,
    getDefaultBranchCommit: async (_configuration, branch) => {
      requestedBranches.push(branch);
      return options.snapshot ?? SNAPSHOT;
    },
    getRepositoryTree: async (_configuration, treeSha) => {
      requestedTrees.push(treeSha);
      return options.tree ?? {
        treeSha: SNAPSHOT.treeSha,
        entries,
        truncated: false,
        readRetryCount: 0,
      };
    },
    getGitBlob: async (_configuration, blobSha): Promise<GitHubBlob> => {
      requestedBlobs.push(blobSha);
      if (options.failedBlobs?.has(blobSha)) {
        throw new GitHubReadError("BLOB_RETRIEVAL_FAILED");
      }
      const entry = entries.find((candidate) => candidate.sha === blobSha);
      const bytes = contents.get(blobSha);
      if (entry === undefined || bytes === undefined) {
        throw new GitHubReadError("BLOB_RETRIEVAL_FAILED");
      }
      return {
        sha: blobSha,
        size: bytes.length,
        encoding: "base64",
        content: Buffer.from(bytes).toString("base64"),
        readRetryCount: 0,
      };
    },
  };
}

async function collectionError(
  operation: Promise<unknown>,
  code: CollectionErrorCode,
): Promise<RepositoryCollectionError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof RepositoryCollectionError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected collection error ${code}.`);
}

test("binds files and root profile to the selected branch commit and tree", async () => {
  const readme = textEntry("README.md", "safe fixture", 3);
  const profile = textEntry(TECHNICAL_PROFILE_PATH, "existing profile", 4);
  const entries = [profile.entry, readme.entry];
  const client = createFakeClient({
    entries,
    contents: new Map([
      [readme.entry.sha, readme.bytes],
      [profile.entry.sha, profile.bytes],
    ]),
  });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client);

  assert.equal(result.defaultBranch, "release/2026");
  assert.equal(result.snapshotCommitSha, SNAPSHOT.commitSha);
  assert.equal(result.snapshotTreeSha, SNAPSHOT.treeSha);
  assert.deepEqual(client.requestedBranches, ["release/2026"]);
  assert.deepEqual(client.requestedTrees, [SNAPSHOT.treeSha]);
  assert.equal(result.files.every((file) => file.sourceCommitSha === SNAPSHOT.commitSha), true);
  assert.equal(result.existingProfile.profilePresent, true);
  if (result.existingProfile.profilePresent) {
    assert.equal(result.existingProfile.file.content, "existing profile");
    assert.equal(result.existingProfile.file.sourceCommitSha, SNAPSHOT.commitSha);
  }
});

test("reports an absent root profile explicitly without treating it as an error", async () => {
  const readme = textEntry("README.md", "safe fixture", 3);
  const client = createFakeClient({ entries: [readme.entry], contents: new Map([[readme.entry.sha, readme.bytes]]) });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client);

  assert.equal(result.status, "complete");
  assert.deepEqual(result.existingProfile, { profilePresent: false });
});

test("does not decode known binaries and distinguishes NUL and invalid UTF-8 content", async () => {
  const image: GitHubTreeEntry = {
    path: "assets/logo.png",
    mode: "100644",
    type: "blob",
    sha: sha(3),
    size: 4,
  };
  const nulBytes = Buffer.from([0x61, 0x00, 0x62]);
  const nulEntry: GitHubTreeEntry = {
    path: "data/nul.dat",
    mode: "100644",
    type: "blob",
    sha: sha(4),
    size: nulBytes.length,
  };
  const invalidUtf8 = Buffer.from([0xff, 0xfe]);
  const invalidEntry: GitHubTreeEntry = {
    path: "data/invalid.txt",
    mode: "100644",
    type: "blob",
    sha: sha(5),
    size: invalidUtf8.length,
  };
  const client = createFakeClient({
    entries: [image, nulEntry, invalidEntry],
    contents: new Map([[nulEntry.sha, nulBytes], [invalidEntry.sha, invalidUtf8]]),
  });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client);

  assert.deepEqual(client.requestedBlobs, [invalidEntry.sha, nulEntry.sha]);
  assert.equal(result.files.find((file) => file.path === "assets/logo.png")?.contentStatus, "binary");
  assert.equal(result.files.find((file) => file.path === "data/nul.dat")?.contentStatus, "binary");
  assert.equal(result.files.find((file) => file.path === "data/invalid.txt")?.contentStatus, "unreadable");
  assert.equal(result.files.some((file) => file.content?.includes("\0")), false);
});

test("never follows symlinks or fetches submodules", async () => {
  const symlink: GitHubTreeEntry = {
    path: "linked-config",
    mode: "120000",
    type: "blob",
    sha: sha(3),
    size: 20,
  };
  const submodule: GitHubTreeEntry = {
    path: "vendor/project",
    mode: "160000",
    type: "commit",
    sha: sha(4),
  };
  const client = createFakeClient({ entries: [symlink, submodule] });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client);

  assert.deepEqual(client.requestedBlobs, []);
  assert.equal(result.files.find((file) => file.path === "linked-config")?.contentStatus, "symlink_not_followed");
  assert.equal(result.files.find((file) => file.path === "vendor/project")?.contentStatus, "submodule_not_fetched");
});

test("preserves the profile-present state and reports per-file and aggregate limits", async () => {
  const oversizedProfile: GitHubTreeEntry = {
    path: TECHNICAL_PROFILE_PATH,
    mode: "100644",
    type: "blob",
    sha: sha(3),
    size: 11,
  };
  const first = textEntry("a.txt", "1234", 4);
  const second = textEntry("b.txt", "5678", 5);
  const client = createFakeClient({
    entries: [second.entry, oversizedProfile, first.entry],
    contents: new Map([[first.entry.sha, first.bytes], [second.entry.sha, second.bytes]]),
  });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client, {
    maxFileBytes: 10,
    maxTextBytes: 5,
  });

  assert.equal(result.existingProfile.profilePresent, true);
  if (result.existingProfile.profilePresent) {
    assert.equal(result.existingProfile.file.contentStatus, "file_size_limit");
  }
  assert.equal(result.files.find((file) => file.path === "b.txt")?.contentStatus, "total_text_limit");
  assert.equal(result.totalTextBytes, 4);
  assert.deepEqual(result.issues, [
    { code: "FILE_SIZE_LIMIT", count: 1 },
    { code: "TOTAL_TEXT_LIMIT", count: 1 },
  ]);
  assert.equal(result.status, "partial");
  assert.deepEqual(client.requestedBlobs, [first.entry.sha]);
});

test("applies the file-count limit deterministically while reserving a slot for the root profile", async () => {
  const a = textEntry("a.txt", "a", 3);
  const b = textEntry("b.txt", "b", 4);
  const profile = textEntry(TECHNICAL_PROFILE_PATH, "profile", 5);
  const contents = new Map([
    [a.entry.sha, a.bytes],
    [b.entry.sha, b.bytes],
    [profile.entry.sha, profile.bytes],
  ]);
  const client = createFakeClient({ entries: [b.entry, profile.entry, a.entry], contents });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client, { maxFiles: 2 });

  assert.deepEqual(result.files.map((file) => file.path), [TECHNICAL_PROFILE_PATH, "a.txt"].sort());
  assert.equal(result.existingProfile.profilePresent, true);
  assert.deepEqual(result.issues, [{ code: "FILE_COUNT_LIMIT", count: 1 }]);
  assert.equal(result.status, "partial");
});

test("fails on a branch that changes during resolution or a truncated tree", async () => {
  const mismatchedClient = createFakeClient({
    snapshot: { ...SNAPSHOT, branch: "main" },
  });
  await collectionError(
    collectRepositorySnapshot(CONFIGURATION, REPOSITORY, mismatchedClient),
    "SNAPSHOT_INCONSISTENT",
  );

  const truncatedClient = createFakeClient({
    tree: { treeSha: SNAPSHOT.treeSha, entries: [], truncated: true, readRetryCount: 0 },
  });
  await collectionError(
    collectRepositorySnapshot(CONFIGURATION, REPOSITORY, truncatedClient),
    "SNAPSHOT_INCONSISTENT",
  );
});

test("reports individual profile blob failures without echoing raw errors", async () => {
  const profile = textEntry(TECHNICAL_PROFILE_PATH, "profile", 3);
  const client = createFakeClient({
    entries: [profile.entry],
    failedBlobs: new Set([profile.entry.sha]),
  });

  const result = await collectRepositorySnapshot(CONFIGURATION, REPOSITORY, client);

  assert.equal(result.status, "partial");
  assert.equal(result.existingProfile.profilePresent, true);
  if (result.existingProfile.profilePresent) {
    assert.equal(result.existingProfile.file.contentStatus, "retrieval_failed");
    assert.equal(result.existingProfile.file.content, undefined);
  }
  assert.deepEqual(result.issues, [{ code: "FILE_RETRIEVAL_FAILED", count: 1 }]);
});