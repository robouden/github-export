// GitHub to Codeberg Migration Tool
// Main entry point

export { GitHubClient } from "./api/github-client.js";
export { CodebergClient } from "./api/codeberg-client.js";
export { StateManager } from "./state/state-manager.js";
export { migrateRepo } from "./migration/repo-migrator.js";
export { syncBranches } from "./migration/branch-sync.js";

import { GitHubClient } from "./api/github-client.js";
import { StateManager } from "./state/state-manager.js";
import { migrateRepo, MigrationConfig } from "./migration/repo-migrator.js";
import { readFile } from "fs/promises";

interface Config {
  batchSize: number;
  maxParallelRepos: number;
  maxBatchesPerRun: number;
  excludeRepos: string[];
  includeOnlyRepos: string[];
}

async function main() {
  const githubToken = process.env.GH_SOURCE_TOKEN;
  const codebergToken = process.env.CODEBERG_TOKEN;
  const sourceOrg = process.env.GH_SOURCE_ORG;
  const targetOrg = process.env.CODEBERG_TARGET_ORG;
  const configPath = process.env.CONFIG_PATH ?? "./config/migration-config.json";
  const statePath = process.env.STATE_PATH ?? "./state/migration-state.json";
  const repoList = process.env.REPO_LIST; // Comma-separated list of repos
  const isOrg = process.env.IS_ORG === "true";

  if (!githubToken || !codebergToken || !sourceOrg || !targetOrg) {
    console.error("Missing required environment variables:");
    console.error("  GH_SOURCE_TOKEN, CODEBERG_TOKEN, GH_SOURCE_ORG, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  // Load config
  const configContent = await readFile(configPath, "utf-8");
  const config: Config = JSON.parse(configContent);

  // Initialize clients
  const githubClient = new GitHubClient({ token: githubToken, org: sourceOrg, isOrg });
  const stateManager = new StateManager(statePath, sourceOrg, targetOrg);

  await stateManager.load();

  // Determine which repos to migrate
  let reposToMigrate: string[];

  if (repoList) {
    // Use provided list
    reposToMigrate = repoList.split(",").map((r) => r.trim()).filter(Boolean);
    console.log(`Processing ${reposToMigrate.length} repos from REPO_LIST`);
  } else {
    // Get repos to process from state
    reposToMigrate = stateManager.getReposToProcess(config.maxParallelRepos);
    console.log(`Processing ${reposToMigrate.length} repos from state`);
  }

  if (reposToMigrate.length === 0) {
    console.log("No repos to migrate!");
    return;
  }

  const migrationConfig: MigrationConfig = {
    githubToken,
    codebergToken,
    sourceOrg,
    targetOrg,
    statePath,
    isOrg,
  };

  // Migrate repos sequentially
  const results = [];
  for (const repoName of reposToMigrate) {
    console.log(`\nProcessing: ${repoName}`);

    const repo = await githubClient.getRepo(repoName);
    if (!repo) {
      console.error(`Repo not found: ${repoName}`);
      continue;
    }

    const result = await migrateRepo(repo, migrationConfig, stateManager);
    results.push(result);
  }

  // Print summary
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("\n" + "=".repeat(60));
  console.log("Migration Summary");
  console.log("=".repeat(60));
  console.log(`Total processed: ${results.length}`);
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed repos:");
    for (const result of results.filter((r) => !r.success)) {
      console.log(`  - ${result.repoName}: ${result.error}`);
    }
  }

  // Exit with error if any migrations failed
  if (failed > 0) {
    process.exit(1);
  }
}

// Run if called directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
