import { Octokit } from "@octokit/rest";
export interface GitHubRepo {
  name: string;
  fullName: string;
  cloneUrl: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  hasWiki: boolean;
  hasIssues: boolean;
  pushedAt: string | null;
}
export interface GitHubClientOptions {
  token: string;
  org: string;
  isOrg?: boolean;
}
export class GitHubClient {
  private octokit: Octokit;
  private org: string;
  private isOrg: boolean;
  constructor(options: GitHubClientOptions) {
    this.isOrg = options.isOrg ?? false;
    this.octokit = new Octokit({
      auth: options.token,
      throttle: {
        onRateLimit: (retryAfter: number, options: { method: string; url: string }, _octokit: Octokit, retryCount: number) => {
          console.warn(`Rate limit hit for ${options.method} ${options.url}`);
          if (retryCount < 3) {
            console.log(`Retrying after ${retryAfter} seconds`);
            return true;
          }
          return false;
        },
        onSecondaryRateLimit: (retryAfter: number, options: { method: string; url: string }) => {
          console.warn(`Secondary rate limit hit for ${options.method} ${options.url}`);
          return true;
        },
      },
    });
    this.org = options.org;
  }
  async listPublicRepos(): Promise<GitHubRepo[]> {
    const repos: GitHubRepo[] = [];
    if (this.isOrg) {
      console.log(`Fetching public repos from org: ${this.org}`);
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.repos.listForOrg,
        {
          org: this.org,
          type: "public" as const,
          per_page: 100,
        }
      )) {
        for (const repo of response.data as any[]) {
          if (!repo.private && !repo.archived) {
            repos.push({
              name: repo.name,
              fullName: repo.full_name,
              cloneUrl: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
              description: repo.description,
              isPrivate: repo.private,
              defaultBranch: repo.default_branch ?? "main",
              hasWiki: repo.has_wiki ?? false,
              hasIssues: repo.has_issues ?? true,
              pushedAt: repo.pushed_at ?? null,
            });
          }
        }
        console.log(`Fetched ${repos.length} repos so far...`);
      }
    } else {
      console.log(`Fetching public repos from user: ${this.org}`);
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.repos.listForUser,
        {
          username: this.org,
          type: "owner" as const,
          per_page: 100,
        }
      )) {
        for (const repo of response.data as any[]) {
          if (!repo.private && !repo.archived) {
            repos.push({
              name: repo.name,
              fullName: repo.full_name,
              cloneUrl: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
              description: repo.description,
              isPrivate: repo.private,
              defaultBranch: repo.default_branch ?? "main",
              hasWiki: repo.has_wiki ?? false,
              hasIssues: repo.has_issues ?? true,
              pushedAt: repo.pushed_at ?? null,
            });
          }
        }
        console.log(`Fetched ${repos.length} repos so far...`);
      }
    }
    console.log(`Total public repos found: ${repos.length}`);
    return repos;
  }
  async getRepo(repoName: string): Promise<GitHubRepo | null> {
    try {
      const { data: repo } = await this.octokit.repos.get({
        owner: this.org,
        repo: repoName,
      });
      return {
        name: repo.name,
        fullName: repo.full_name,
        cloneUrl: repo.clone_url ?? `https://github.com/${repo.full_name}.git`,
        description: repo.description,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch ?? "main",
        hasWiki: repo.has_wiki ?? false,
        hasIssues: repo.has_issues ?? true,
        pushedAt: repo.pushed_at ?? null,
      };
    } catch (error) {
      console.error(`Failed to get repo ${repoName}:`, error);
      return null;
    }
  }
  async listBranches(repoName: string): Promise<string[]> {
    const branches: string[] = [];
    for await (const response of this.octokit.paginate.iterator(
      this.octokit.repos.listBranches,
      {
        owner: this.org,
        repo: repoName,
        per_page: 100,
      }
    )) {
      for (const branch of response.data) {
        branches.push(branch.name);
      }
    }
    return branches;
  }
}