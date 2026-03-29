import { readFile, writeFile } from "fs/promises";
import { GitHubClient, GitHubRepo } from "../api/github-client.js";
import { StateManager } from "../state/state-manager.js";

interface MigrationConfig {
  batchSize: number;
  maxParallelRepos: number;
  maxBatchesPerRun: number;
  excludeRepos: string[];
  includeOnlyRepos: string[];
}

interface Batch {
  batchNumber: number;
  repos: string[];
}

async function loadConfig(configPath: string): Promise<MigrationConfig> {
  const content = await readFile(configPath, "utf-8");
  return JSON.parse(content);
}

async function discoverRepos(
  githubClient: GitHubClient,
  stateManager: StateManager,
  config: MigrationConfig,
  excludeInactiveDays: number
): Promise<string[]> {
  console.log("Discovering repos from GitHub...");

  const repos = await githubClient.listPublicRepos();

  // Apply filters
  let filteredRepos: GitHubRepo[] = repos;

  if (config.includeOnlyRepos && config.includeOnlyRepos.length > 0) {
    filteredRepos = filteredRepos.filter((repo) =>
      config.includeOnlyRepos.includes(repo.name)
    );
    console.log(`Filtered to ${filteredRepos.length} repos (include list)`);
  }

  if (config.excludeRepos && config.excludeRepos.length > 0) {
    filteredRepos = filteredRepos.filter(
      (repo) => !config.excludeRepos.includes(repo.name)
    );
    console.log(`Filtered to ${filteredRepos.length} repos (exclude list)`);
  }

  // Update githubPushedAt for ALL repos (before activity filtering)
  // This ensures we always have the latest GitHub state for sync detection
  const allReposWithPushedAt = filteredRepos.map((r) => ({
    name: r.name,
    pushedAt: r.pushedAt ?? undefined,
  }));
  stateManager.addReposWithPushedAt(allReposWithPushedAt);

  // Filter by activity (exclude repos with no commits in the last X days)
  // Also mark existing pending repos as skipped if they are now inactive
  if (excludeInactiveDays > 0) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - excludeInactiveDays);

    const beforeCount = filteredRepos.length;

    filteredRepos = filteredRepos.filter((repo) => {
      if (!repo.pushedAt) return false;
      const pushedDate = new Date(repo.pushedAt);
      return pushedDate >= cutoffDate;
    });
    console.log(`Filtered to ${filteredRepos.length} repos (excluded ${beforeCount - filteredRepos.length} inactive repos with no commits in last ${excludeInactiveDays} days)`);

    // Mark existing pending repos as skipped if they are inactive
    const activeRepoNames = new Set(filteredRepos.map((r) => r.name));
    const pendingRepos = stateManager.getPendingRepos();
    let skippedCount = 0;

    for (const repoName of pendingRepos) {
      if (!activeRepoNames.has(repoName)) {
        stateManager.markSkipped(repoName, `Inactive: no commits in last ${excludeInactiveDays} days`);
        skippedCount++;
      }
    }

    if (skippedCount > 0) {
      console.log(`Marked ${skippedCount} existing pending repos as skipped (inactive)`);
    }
  }

  await stateManager.save();

  return filteredRepos.map((r) => r.name);
}

function createBatches(repos: string[], batchSize: number): Batch[] {
  const batches: Batch[] = [];

  for (let i = 0; i < repos.length; i += batchSize) {
    batches.push({
      batchNumber: Math.floor(i / batchSize) + 1,
      repos: repos.slice(i, i + batchSize),
    });
  }

  return batches;
}

async function main() {
  const githubToken = process.env.GH_SOURCE_TOKEN;
  const sourceOrg = process.env.GH_SOURCE_ORG;
  const targetOrg = process.env.CODEBERG_TARGET_ORG;
  const configPath = process.env.CONFIG_PATH ?? "./config/migration-config.json";
  const statePath = process.env.STATE_PATH ?? "./state/migration-state.json";
  const outputPath = process.env.OUTPUT_PATH ?? "./state/batches.json";
  const maxBatches = parseInt(process.env.MAX_BATCHES ?? "5", 10);
  const excludeInactiveDays = parseInt(process.env.EXCLUDE_INACTIVE_DAYS ?? "0", 10);
  const enableSync = process.env.ENABLE_SYNC === "true";

  if (!githubToken || !sourceOrg || !targetOrg) {
    console.error("Missing required environment variables:");
    console.error("  GH_SOURCE_TOKEN, GH_SOURCE_ORG, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  const config = await loadConfig(configPath);
  const isOrg = process.env.IS_ORG === "true";
  const githubClient = new GitHubClient({ token: githubToken, org: sourceOrg, isOrg });
  const stateManager = new StateManager(statePath, sourceOrg, targetOrg);

  await stateManager.load();

  // Discover and update state (also updates githubPushedAt for existing repos)
  await discoverRepos(githubClient, stateManager, config, excludeInactiveDays);

  // Get repos to process (failed retryable + pending + optionally needing sync)
  const reposToProcess = stateManager.getReposToProcess(
    maxBatches * config.batchSize,
    enableSync,
    excludeInactiveDays
  );

  if (enableSync) {
    console.log("\nSync mode enabled: including completed repos that have new GitHub commits");
  }

  console.log(`\nRepos to process this run: ${reposToProcess.length}`);

  // Create batches
  const batches = createBatches(reposToProcess, config.batchSize);
  const batchesToRun = batches.slice(0, maxBatches);

  console.log(`Created ${batches.length} total batches`);
  console.log(`Will run ${batchesToRun.length} batches this execution`);

  // Output batch info
  const output = {
    timestamp: new Date().toISOString(),
    totalRepos: reposToProcess.length,
    totalBatches: batches.length,
    batchesToRun: batchesToRun.length,
    batches: batchesToRun,
    stats: stateManager.getStats(excludeInactiveDays),
  };

  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nBatch info written to ${outputPath}`);

  // Output for GitHub Actions
  const batchMatrix = batchesToRun.map((b) => ({
    batch_number: b.batchNumber,
    repos: b.repos.join(","),
  }));

  // Set output for GitHub Actions
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const { appendFile } = await import("fs/promises");
    await appendFile(ghOutput, `batch_count=${batchesToRun.length}\n`);
    await appendFile(ghOutput, `batch_matrix=${JSON.stringify(batchMatrix)}\n`);
    await appendFile(ghOutput, `total_repos=${reposToProcess.length}\n`);
  }

  // Print summary
  const stats = stateManager.getStats(excludeInactiveDays);
  console.log("\n--- Migration State Summary ---");
  console.log(`Total repos tracked: ${stats.total}`);
  console.log(`Pending: ${stats.pending}`);
  console.log(`In Progress: ${stats.inProgress}`);
  console.log(`Completed: ${stats.completed}`);
  console.log(`Failed: ${stats.failed}`);
  console.log(`Skipped: ${stats.skipped}`);
  console.log(`Needing Sync: ${stats.needingSync}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
