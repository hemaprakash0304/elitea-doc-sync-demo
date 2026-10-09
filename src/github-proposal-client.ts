import { createSign, createHash } from "node:crypto";
import type { RunConfiguration } from "./config.js";
import type { GitHubRepositoryMetadata } from "./github-client.js";
import { TECHNICAL_PROFILE_PATH } from "./collection.js";
import type {
  ProposalBranchResult,
  ProposalCommitResult,
  ProposalPullRequestResult,
  ProposalWriteCapability,
  ProposalWriteClient,
} from "./proposal.js";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 15_000;
const BRANCH_PATTERN = /^docs-sync\/technical-profile\/[a-z0-9-]+-[a-f0-9]{12}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/i;

export interface ProposalAppEnvironment {
  DOCS_SYNC_PROPOSAL_APP_ID?: string;
  DOCS_SYNC_PROPOSAL_APP_INSTALLATION_ID?: string;
  DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY?: string;
  DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED?: string;
}

export interface GitHubProposalClientOptions {
  fetchImplementation?: typeof fetch;
  nowSeconds?: () => number;
  signJwt?: (payload: string, privateKey: string) => string;
}

export function createGitHubProposalWriteClient(
  configuration: RunConfiguration,
  repository: GitHubRepositoryMetadata,
  environment: ProposalAppEnvironment = process.env,
  options: GitHubProposalClientOptions = {},
): ProposalWriteClient | undefined {
  if (configuration.executionContext !== "actions") return undefined;

  const normalizedTarget = configuration.normalizedRepositoryId.toLowerCase();
  if (
    normalizedTarget !== configuration.targetRepository.toLowerCase() ||
    normalizedTarget !== repository.normalizedRepositoryId.toLowerCase() ||
    normalizedTarget !== repository.fullName.toLowerCase() ||
    !Number.isSafeInteger(repository.repositoryId) || repository.repositoryId <= 0 ||
    environment.DOCS_SYNC_PROPOSAL_BRANCH_PROTECTION_CONFIRMED !== "true"
  ) {
    return undefined;
  }

  const appId = environment.DOCS_SYNC_PROPOSAL_APP_ID;
  const installationId = environment.DOCS_SYNC_PROPOSAL_APP_INSTALLATION_ID;
  const privateKey = environment.DOCS_SYNC_PROPOSAL_APP_PRIVATE_KEY;
  if (
    appId === undefined || !isPositiveInteger(appId) ||
    installationId === undefined || !isPositiveInteger(installationId) ||
    privateKey === undefined || privateKey.trim().length === 0
  ) {
    return undefined;
  }

  return new GitHubAppProposalWriteClient(configuration, repository, {
    appId,
    installationId,
    privateKey,
    fetchImplementation: options.fetchImplementation ?? globalThis.fetch,
    nowSeconds: options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
    signJwt: options.signJwt ?? signAppJwt,
  });
}

interface ResolvedProposalOptions {
  appId: string;
  installationId: string;
  privateKey: string;
  fetchImplementation: typeof fetch;
  nowSeconds: () => number;
  signJwt: (payload: string, privateKey: string) => string;
}

class GitHubAppProposalWriteClient implements ProposalWriteClient {
  readonly capability: ProposalWriteCapability;
  private readonly owner: string;
  private readonly repositoryName: string;
  private readonly branches = new Map<string, string>();
  private readonly pullRequests = new Set<number>();
  private token: string | undefined;

  constructor(
    private readonly configuration: RunConfiguration,
    private readonly repository: GitHubRepositoryMetadata,
    private readonly options: ResolvedProposalOptions,
  ) {
    const [owner, repositoryName] = configuration.targetRepository.split("/");
    if (owner === undefined || repositoryName === undefined) {
      throw new Error("Proposal target is invalid.");
    }
    this.owner = owner;
    this.repositoryName = repositoryName;
    this.capability = {
      provider: "dedicated_github_proposal_app",
      normalizedRepositoryId: configuration.normalizedRepositoryId,
      repositoryId: repository.repositoryId,
      permissions: {
        contents: "write",
        pullRequests: "write",
        canApprove: false,
        canMerge: false,
        canBypassBranchProtection: false,
        canWriteDefaultBranch: false,
      },
      branchProtection: {
        pullRequestRequired: true,
        humanApprovalRequired: true,
        proposalAppBypass: false,
      },
    };
  }

  async createFeatureBranch(input: Parameters<ProposalWriteClient["createFeatureBranch"]>[0]): Promise<ProposalBranchResult> {
    this.assertTarget(input.repositoryId, input.repositoryFullName);
    if (
      !BRANCH_PATTERN.test(input.branchName) || !SHA_PATTERN.test(input.baseCommitSha) ||
      !DIGEST_PATTERN.test(input.candidateSha256) || input.baseBranch !== this.repository.defaultBranch
    ) {
      throw safeProposalError();
    }
    const existingProposal = await this.findExistingOpenProposal(input);
    if (existingProposal !== undefined) return existingProposal;
    const response = await this.request("POST", "/git/refs", {
      ref: `refs/heads/${input.branchName}`,
      sha: input.baseCommitSha,
    }, input.signal, [422]);
    if (response.status === 422) {
      return { status: "ALREADY_EXISTS", branchName: input.branchName, baseCommitSha: input.baseCommitSha, failureCode: "BRANCH_COLLISION" };
    }
    const result = await jsonObject(response);
    if (result.ref !== `refs/heads/${input.branchName}` || nestedString(result, "object", "sha") !== input.baseCommitSha.toLowerCase()) {
      throw safeProposalError();
    }
    this.branches.set(input.branchName, input.baseCommitSha.toLowerCase());
    return { status: "CREATED", branchName: input.branchName, baseCommitSha: input.baseCommitSha.toLowerCase() };
  }

  private async findExistingOpenProposal(
    input: Parameters<ProposalWriteClient["createFeatureBranch"]>[0],
  ): Promise<ProposalBranchResult | undefined> {
    const response = await this.request("GET", "/pulls?state=open&per_page=100", undefined, input.signal);
    let proposals: unknown;
    try {
      proposals = await response.json();
    } catch {
      return existingProposalUnverified(input);
    }
    if (!Array.isArray(proposals)) return existingProposalUnverified(input);

    for (const proposal of proposals) {
      if (!isRecord(proposal) || proposal.state !== "open") continue;
      const head = isRecord(proposal.head) ? proposal.head : undefined;
      const base = isRecord(proposal.base) ? proposal.base : undefined;
      const headRepository = head !== undefined && isRecord(head.repo) ? head.repo : undefined;
      const headRepositoryName = headRepository?.full_name;
      const headBranch = head?.ref;
      const baseBranch = base?.ref;
      if (
        typeof headRepositoryName !== "string" ||
        headRepositoryName.toLowerCase() !== this.repository.fullName.toLowerCase() ||
        typeof headBranch !== "string" ||
        !headBranch.startsWith("docs-sync/technical-profile/") || baseBranch !== this.repository.defaultBranch
      ) {
        continue;
      }

      const body = typeof proposal.body === "string" ? proposal.body : "";
      const snapshot = /^- Snapshot: ([a-f0-9]{40})$/m.exec(body)?.[1];
      const digest = /^- Profile digest: ([a-f0-9]{64})$/m.exec(body)?.[1];
      if (
        proposal.title === "docs: update technical profile" &&
        snapshot === input.baseCommitSha.toLowerCase() &&
        digest === input.candidateSha256.toLowerCase()
      ) {
        return {
          status: "ALREADY_EXISTS",
          branchName: input.branchName,
          baseCommitSha: input.baseCommitSha.toLowerCase(),
          failureCode: "OPEN_PROPOSAL_EXISTS",
        };
      }
      return {
        status: "ALREADY_EXISTS",
        branchName: input.branchName,
        baseCommitSha: input.baseCommitSha.toLowerCase(),
        failureCode: "OPEN_PROPOSAL_CONFLICT",
      };
    }

    if (response.headers.get("link")?.includes('rel="next"') === true) {
      return existingProposalUnverified(input);
    }
    return undefined;
  }

  async commitSingleProfileFile(input: Parameters<ProposalWriteClient["commitSingleProfileFile"]>[0]): Promise<ProposalCommitResult> {
    this.assertTarget(input.repositoryId, input.repositoryFullName);
    const baseCommitSha = this.branches.get(input.branchName);
    if (
      baseCommitSha === undefined || baseCommitSha !== input.baseCommitSha.toLowerCase() ||
      !SHA_PATTERN.test(input.baseTreeSha) || input.path !== TECHNICAL_PROFILE_PATH ||
      input.commitMessage !== "docs: update technical profile"
    ) {
      throw safeProposalError();
    }

    const blobResponse = await this.request("POST", "/git/blobs", {
      content: input.content,
      encoding: "utf-8",
    }, input.signal);
    const blobSha = requiredSha(await jsonObject(blobResponse), "sha");
    const treeResponse = await this.request("POST", "/git/trees", {
      base_tree: input.baseTreeSha,
      tree: [{ path: TECHNICAL_PROFILE_PATH, mode: "100644", type: "blob", sha: blobSha }],
    }, input.signal);
    const treeSha = requiredSha(await jsonObject(treeResponse), "sha");
    const commitResponse = await this.request("POST", "/git/commits", {
      message: "docs: update technical profile",
      tree: treeSha,
      parents: [baseCommitSha],
    }, input.signal);
    const commit = await jsonObject(commitResponse);
    const commitSha = requiredSha(commit, "sha");
    const parent = Array.isArray(commit.parents) ? commit.parents[0] : undefined;
    if (nestedString({ parent }, "parent", "sha") !== baseCommitSha) throw safeProposalError();

    const updateResponse = await this.request("PATCH", `/git/refs/heads/${input.branchName}`, {
      sha: commitSha,
      force: false,
    }, input.signal);
    if (nestedString(await jsonObject(updateResponse), "object", "sha") !== commitSha) throw safeProposalError();
    this.branches.set(input.branchName, commitSha);
    return {
      commitSha,
      parentCommitSha: baseCommitSha,
      treeSha,
      changedPaths: [TECHNICAL_PROFILE_PATH],
      profileSha256: sha256(input.content),
    };
  }

  async getBranchHead(input: Parameters<ProposalWriteClient["getBranchHead"]>[0]): Promise<{ branchName: string; commitSha: string }> {
    this.assertTarget(input.repositoryId, input.repositoryFullName);
    if (!this.branches.has(input.branchName)) throw safeProposalError();
    const result = await jsonObject(await this.request(
      "GET",
      `/git/ref/heads/${input.branchName}`,
      undefined,
      input.signal,
    ));
    return { branchName: input.branchName, commitSha: requiredSha(nestedObject(result, "object"), "sha") };
  }

  async createPullRequest(input: Parameters<ProposalWriteClient["createPullRequest"]>[0]): Promise<ProposalPullRequestResult> {
    this.assertTarget(input.repositoryId, input.repositoryFullName);
    if (
      !this.branches.has(input.headBranch) || input.baseBranch !== this.repository.defaultBranch ||
      input.title !== "docs: update technical profile"
    ) {
      throw safeProposalError();
    }
    const result = await jsonObject(await this.request("POST", "/pulls", {
      title: "docs: update technical profile",
      body: input.body,
      head: input.headBranch,
      base: this.repository.defaultBranch,
    }, input.signal));
    const head = nestedObject(result, "head");
    const base = nestedObject(result, "base");
    if (
      result.state !== "open" || !Number.isSafeInteger(result.number) ||
      typeof result.html_url !== "string" || head.ref !== input.headBranch || base.ref !== this.repository.defaultBranch
    ) {
      throw safeProposalError();
    }
    this.pullRequests.add(result.number as number);
    return {
      number: result.number as number,
      url: result.html_url,
      state: "open",
      headBranch: input.headBranch,
      baseBranch: this.repository.defaultBranch,
    };
  }

  async closePullRequest(input: Parameters<ProposalWriteClient["closePullRequest"]>[0]): Promise<boolean> {
    this.assertTarget(input.repositoryId, input.repositoryFullName);
    if (!this.pullRequests.has(input.pullRequestNumber)) throw safeProposalError();
    const result = await jsonObject(await this.request("PATCH", `/pulls/${input.pullRequestNumber}`, {
      state: "closed",
    }, input.signal));
    return result.state === "closed";
  }

  private assertTarget(repositoryId: number, repositoryFullName: string): void {
    if (
      repositoryId !== this.repository.repositoryId ||
      repositoryFullName.toLowerCase() !== this.configuration.normalizedRepositoryId.toLowerCase()
    ) {
      throw safeProposalError();
    }
  }

  private async request(
    method: string,
    endpoint: string,
    body: unknown,
    signal: AbortSignal,
    acceptedErrorStatuses: readonly number[] = [],
  ): Promise<Response> {
    const token = await this.getInstallationToken(signal);
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      const response = await this.options.fetchImplementation(`${GITHUB_API_BASE}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repositoryName)}${endpoint}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestSignal,
      });
      if (!response.ok && !acceptedErrorStatuses.includes(response.status)) throw safeProposalError();
      return response;
    } catch {
      throw safeProposalError();
    }
  }

  private async getInstallationToken(signal: AbortSignal): Promise<string> {
    if (this.token !== undefined) return this.token;
    const issuedAt = this.options.nowSeconds();
    let jwt: string;
    try {
      const payload = JSON.stringify({ iss: this.options.appId, iat: issuedAt - 60, exp: issuedAt + 540 });
      jwt = this.options.signJwt(payload, this.options.privateKey);
    } catch {
      throw safeProposalError();
    }
    let response: Response;
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
      response = await this.options.fetchImplementation(`${GITHUB_API_BASE}/app/installations/${this.options.installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({
          repositories: [this.repository.fullName],
          permissions: { metadata: "read", contents: "write", pull_requests: "write" },
        }),
        signal: requestSignal,
      });
    } catch {
      throw safeProposalError();
    }
    const result = await jsonObject(response);
    if (!response.ok || typeof result.token !== "string" || result.token.length === 0) throw safeProposalError();
    this.token = result.token;
    return result.token;
  }
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw safeProposalError();
  try {
    const value: unknown = await response.json();
    return isRecord(value) ? value : (() => { throw safeProposalError(); })();
  } catch {
    throw safeProposalError();
  }
}

function nestedObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) throw safeProposalError();
  return nested;
}

function nestedString(value: Record<string, unknown>, objectKey: string, propertyKey: string): string | undefined {
  const nested = value[objectKey];
  if (!isRecord(nested)) return undefined;
  return typeof nested[propertyKey] === "string" ? nested[propertyKey] as string : undefined;
}

function requiredSha(value: Record<string, unknown>, key: string): string {
  const sha = value[key];
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) throw safeProposalError();
  return sha.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0;
}

function signAppJwt(payload: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(payload).toString("base64url");
  const unsigned = `${header}.${encodedPayload}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).end().sign(privateKey, "base64url")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function safeProposalError(): Error {
  return new Error("GitHub proposal operation failed safely.");
}

function existingProposalUnverified(
  input: Parameters<ProposalWriteClient["createFeatureBranch"]>[0],
): ProposalBranchResult {
  return {
    status: "ALREADY_EXISTS",
    branchName: input.branchName,
    baseCommitSha: input.baseCommitSha.toLowerCase(),
    failureCode: "OPEN_PROPOSAL_STATE_UNVERIFIED",
  };
}