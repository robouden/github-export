import pRetry from "p-retry";
import { execFileSync } from "child_process";

export interface CodebergRepo {
  id: number;
  name: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
}

export interface CodebergClientOptions {
  token: string;
  org: string;
  baseUrl?: string;
  isOrg?: boolean;
}

export interface CreateRepoOption {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
  default_branch?: string;
}

export class CodebergClient {
  private token: string;
  private org: string;
  private baseUrl: string;
  private isOrg: boolean;

  constructor(options: CodebergClientOptions) {
    this.token = options.token;
    this.org = options.org;
    this.baseUrl = options.baseUrl ?? "https://codeberg.org/api/v1";
    this.isOrg = options.isOrg ?? false;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const args: string[] = [
      "-s", "-w", "\n%{http_code}",
      "-X", method,
      "-H", `Authorization: token ${this.token}`,
      "-H", "Content-Type: application/json",
      "-H", "Accept: application/json",
    ];

    if (body) {
      args.push("-d", JSON.stringify(body));
    }

    args.push(url);

    let output: string;
    try {
      output = execFileSync("curl", args, {
        encoding: "utf-8",
        timeout: 30000,
      }).trim();
    } catch (err: any) {
      throw new Error(`curl request failed: ${err.message}`);
    }

    const lines = output.split("\n");
    const statusCode = parseInt(lines[lines.length - 1], 10);
    const responseBody = lines.slice(0, -1).join("\n");

    if (statusCode < 200 || statusCode >= 300) {
      const error = new Error(
        `Codeberg API error: ${statusCode} - ${responseBody}`,
      );
      (error as any).status = statusCode;
      (error as any).response = responseBody;
      throw error;
    }

    return responseBody ? JSON.parse(responseBody) : ({} as T);
  }

  async repoExists(repoName: string): Promise<boolean> {
    try {
      await this.request("GET", `/repos/${this.org}/${repoName}`);
      return true;
    } catch (error: any) {
      if (error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async getRepo(repoName: string): Promise<CodebergRepo | null> {
    try {
      return await this.request<CodebergRepo>(
        "GET",
        `/repos/${this.org}/${repoName}`,
      );
    } catch (error: any) {
      if (error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async createRepo(options: CreateRepoOption): Promise<CodebergRepo> {
    console.log(`Creating repo ${this.org}/${options.name}...`);
    const createPath = this.isOrg ? `/orgs/${this.org}/repos` : `/user/repos`;
    return await pRetry(
      async () => {
        return await this.request<CodebergRepo>(
          "POST",
          createPath,
          options,
        );
      },
      {
        retries: 3,
        onFailedAttempt: (error) => {
          console.warn(
            `Create repo attempt ${error.attemptNumber} failed: ${error.message}`,
          );
        },
      },
    );
  }

  async ensureRepo(
    repoName: string,
    description?: string,
    isPrivate = false,
  ): Promise<{ repo: CodebergRepo; alreadyExisted: boolean }> {
    const existing = await this.getRepo(repoName);
    if (existing) {
      console.log(`Repository ${repoName} already exists on Codeberg`);
      return { repo: existing, alreadyExisted: true };
    }

    const repo = await this.createRepo({
      name: repoName,
      description: description ?? "",
      private: isPrivate,
      auto_init: false,
    });
    return { repo, alreadyExisted: false };
  }

  async deleteRepo(repoName: string): Promise<void> {
    console.log(`Deleting repo ${this.org}/${repoName}...`);
    await this.request("DELETE", `/repos/${this.org}/${repoName}`);
  }

  async updateRepo(
    repoName: string,
    updates: { description?: string; private?: boolean },
  ): Promise<CodebergRepo> {
    return await this.request<CodebergRepo>(
      "PATCH",
      `/repos/${this.org}/${repoName}`,
      updates,
    );
  }

  getCloneUrlWithAuth(repoName: string): string {
    return `https://${this.token}@codeberg.org/${this.org}/${repoName}.git`;
  }

  async listOrgRepos(): Promise<CodebergRepo[]> {
    const allRepos: CodebergRepo[] = [];
    let page = 1;
    const limit = 50;
    const listBase = this.isOrg ? `/orgs/${this.org}/repos` : `/users/${this.org}/repos`;

    while (true) {
      const repos = await this.request<CodebergRepo[]>(
        "GET",
        `${listBase}?page=${page}&limit=${limit}`,
      );

      if (repos.length === 0) {
        break;
      }

      allRepos.push(...repos);
      page++;

      if (repos.length < limit) {
        break;
      }
    }

    return allRepos;
  }
}
