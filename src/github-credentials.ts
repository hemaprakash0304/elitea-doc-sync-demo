import { createSign } from "node:crypto";
import type { ExecutionContext, RunConfiguration } from "./config.js";
import { GitHubReadError } from "./github-errors.js";

export interface GitHubReadCredentialProvider {
  getReadToken(configuration: RunConfiguration): Promise<string | undefined>;
}

export interface LocalCredentialStore {
  getPassword(service: string, account: string): Promise<string | null>;
}

export interface GitHubAppCredentialEnvironment {
  DOCS_SYNC_READ_APP_ID?: string;
  DOCS_SYNC_READ_APP_INSTALLATION_ID?: string;
  DOCS_SYNC_READ_APP_PRIVATE_KEY?: string;
}

export interface GitHubAppTokenProviderOptions {
  environment: GitHubAppCredentialEnvironment;
  fetchImplementation?: typeof fetch;
  nowSeconds?: () => number;
  signJwt?: (payload: string, privateKey: string) => string;
}

export interface DefaultCredentialProviderOptions {
  executionContext: ExecutionContext;
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  loadLocalCredentialStore?: () => Promise<LocalCredentialStore>;
}

const KEYCHAIN_SERVICE = "automated-documentation-sync";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

export class LocalKeychainCredentialProvider implements GitHubReadCredentialProvider {
  constructor(private readonly loadCredentialStore: () => Promise<LocalCredentialStore> = loadKeytar) {}

  async getReadToken(configuration: RunConfiguration): Promise<string | undefined> {
    let store: LocalCredentialStore;
    try {
      store = await this.loadCredentialStore();
    } catch {
      throw new GitHubReadError("CREDENTIAL_STORE_UNAVAILABLE");
    }

    try {
      const password = await store.getPassword(KEYCHAIN_SERVICE, configuration.normalizedRepositoryId);
      return password === null || password.trim().length === 0 ? undefined : password;
    } catch {
      throw new GitHubReadError("CREDENTIAL_STORE_UNAVAILABLE");
    }
  }
}

export class GitHubActionsAppCredentialProvider implements GitHubReadCredentialProvider {
  private readonly fetchImplementation: typeof fetch;
  private readonly nowSeconds: () => number;
  private readonly signJwt: (payload: string, privateKey: string) => string;

  constructor(private readonly options: GitHubAppTokenProviderOptions) {
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.signJwt = options.signJwt ?? signAppJwt;
  }

  async getReadToken(configuration: RunConfiguration): Promise<string | undefined> {
    const { DOCS_SYNC_READ_APP_ID: appId, DOCS_SYNC_READ_APP_INSTALLATION_ID: installationId, DOCS_SYNC_READ_APP_PRIVATE_KEY: privateKey } = this.options.environment;
    const configuredValues = [appId, installationId, privateKey];
    if (configuredValues.every((value) => value === undefined || value === "")) {
      return undefined;
    }
    if (
      appId === undefined || !isPositiveInteger(appId) ||
      installationId === undefined || !isPositiveInteger(installationId) ||
      privateKey === undefined || privateKey.trim().length === 0
    ) {
      throw new GitHubReadError("CREDENTIAL_CONFIGURATION_INVALID");
    }

    const now = this.nowSeconds();
    const payload = JSON.stringify({ iss: appId, iat: now - 60, exp: now + 540 });
    let appJwt: string;
    try {
      appJwt = this.signJwt(payload, privateKey);
    } catch {
      throw new GitHubReadError("CREDENTIAL_CONFIGURATION_INVALID");
    }

    const [owner, repository] = configuration.targetRepository.split("/");
    if (owner === undefined || repository === undefined) {
      throw new GitHubReadError("CREDENTIAL_CONFIGURATION_INVALID");
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${appJwt}`,
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
          },
          body: JSON.stringify({
            repositories: [`${owner}/${repository}`],
            permissions: { metadata: "read", contents: "read" },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw new GitHubReadError("NETWORK_FAILURE");
    }

    if (response.status === 401) {
      throw new GitHubReadError("AUTHENTICATION_FAILED");
    }
    if (response.status === 403) {
      if (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")) {
        throw new GitHubReadError("RATE_LIMITED");
      }
      throw new GitHubReadError("AUTHORIZATION_FAILED");
    }
    if (response.status === 429) {
      throw new GitHubReadError("RATE_LIMITED");
    }
    if (!response.ok) {
      throw new GitHubReadError(response.status === 429 ? "RATE_LIMITED" : "CREDENTIAL_CONFIGURATION_INVALID");
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new GitHubReadError("INVALID_RESPONSE");
    }
    if (typeof result !== "object" || result === null || !("token" in result) || typeof result.token !== "string" || result.token.length === 0) {
      throw new GitHubReadError("INVALID_RESPONSE");
    }

    return result.token;
  }
}

export function createDefaultCredentialProvider(
  options: DefaultCredentialProviderOptions,
): GitHubReadCredentialProvider {
  if (options.executionContext === "actions") {
    return new GitHubActionsAppCredentialProvider({
      environment: options.environment ?? process.env,
      ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
    });
  }

  return new LocalKeychainCredentialProvider(options.loadLocalCredentialStore);
}

function signAppJwt(payload: string, privateKey: string): string {
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = encodeBase64Url(payload);
  const unsignedToken = `${header}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(unsignedToken).end().sign(privateKey, "base64url");
  return `${unsignedToken}.${signature}`;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function isPositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(parsed) && parsed > 0;
}

async function loadKeytar(): Promise<LocalCredentialStore> {
  return import("keytar");
}