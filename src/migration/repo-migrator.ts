import { GitHubClient, GitHubRepo } from "../api/github-client.js";
import { CodebergClient } from "../api/codeberg-client.js";
import { StateManager, ErrorType } from "../state/state-manager.js";
import { syncBranches } from "./branch-sync.js";

export interface MigrationConfig {
  githubToken: string;
  codebergToken: string;
  sourceOrg: string;
  targetOrg: string;
  statePath: string;
  workDir?: string;
  isOrg?: boolean;
}

export interface MigrationResult {
  repoName: string;
  success: boolean;
  phases: {
    repoCreation: boolean;
    branchSync: boolean;
  };
  error?: string;
  errorType?: ErrorType;
}

function classifyError(error: unknown): ErrorType {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Transient errors - auto-retry
  if (
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("timeout") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("enotfound") ||
    lowerMessage.includes("network") ||
    lowerMessage.includes("503") ||
    lowerMessage.includes("502") ||
    lowerMessage.includes("504")
  ) {
    return "transient";
  }

  // Recoverable errors - can continue with manual intervention
  if (
    lowerMessage.includes("already exists") ||
    lowerMessage.includes("409") ||
    lowerMessage.includes("conflict")
  ) {
    return "recoverable";
  }

  // Permanent errors - skip
  if (
    lowerMessage.includes("not found") ||
    lowerMessage.includes("404") ||
    lowerMessage.includes("forbidden") ||
    lowerMessage.includes("403") ||
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("401")
  ) {
    return "permanent";
  }

  // Default to transient for unknown errors
  return "transient";
}

export async function migrateRepo(
  githubRepo: GitHubRepo,
  config: MigrationConfig,
  stateManager: StateManager
): Promise<MigrationResult> {
  const { name: repoName } = githubRepo;

  const currentState = stateManager.getRepoState(repoName);
  const isSyncOnly = currentState?.status === "completed";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Starting ${isSyncOnly ? "sync" : "migration"}: ${repoName}`);
  console.log(`${"=".repeat(60)}`);

  const result: MigrationResult = {
    repoName,
    success: false,
    phases: {
      repoCreation: false,
      branchSync: false,
    },
  };

  // For sync-only mode, don't change status to in_progress (keep completed)
  if (!isSyncOnly) {
    stateManager.markInProgress(repoName);
    await stateManager.save();
  }

  const codebergClient = new CodebergClient({
    token: config.codebergToken,
    org: config.targetOrg,
    isOrg: config.isOrg,
  });

  // Phase 1: Ensure repo exists on Codeberg
  console.log(`\n[Phase 1] Ensuring repo exists on Codeberg: ${repoName}`);

  try {
    const { alreadyExisted } = await codebergClient.ensureRepo(
      repoName,
      githubRepo.description ?? undefined,
      githubRepo.isPrivate
    );

    if (alreadyExisted) {
      console.log(`Repo already exists, continuing to branch sync`);
    } else {
      console.log(`Repo created on Codeberg`);
    }

    result.phases.repoCreation = true;
    stateManager.markPhaseComplete(repoName, "apiMigration");
    await stateManager.save();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorType = classifyError(error);

    console.error(`Repo creation failed: ${errorMessage}`);
    result.error = errorMessage;
    result.errorType = errorType;
    stateManager.markFailed(repoName, errorMessage, errorType);
    await stateManager.save();
    return result;
  }

  // Phase 2: Branch Sync (force push all branches and tags)
  // Always run for sync-only mode (to update with new commits)
  console.log(`\n[Phase 2] Branch Sync for ${repoName}`);

  const shouldSkipBranchSync = !isSyncOnly && currentState?.phases.branchSync === true;

  if (shouldSkipBranchSync) {
    console.log(`Branch sync already completed, skipping`);
    result.phases.branchSync = true;
  } else {
    if (isSyncOnly) {
      console.log(`Sync mode: updating Codeberg with latest GitHub commits`);
    }
    try {
      const syncResult = await syncBranches({
        sourceUrl: githubRepo.cloneUrl,
        targetUrl: `https://codeberg.org/${config.targetOrg}/${repoName}.git`,
        sourceToken: config.githubToken,
        targetToken: config.codebergToken,
        workDir: config.workDir ?? "/tmp/migration",
      });

      if (syncResult.success) {
        console.log(`Branch sync completed: ${syncResult.branchesProcessed} refs synced`);
        result.phases.branchSync = true;
        stateManager.markPhaseComplete(repoName, "branchSync");
        // Update lastSyncedAt with current GitHub pushed_at
        stateManager.updateLastSynced(repoName, githubRepo.pushedAt ?? undefined);
      } else {
        throw new Error(syncResult.error ?? "Branch sync failed");
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorType = classifyError(error);

      console.error(`Branch sync failed: ${errorMessage}`);
      result.error = errorMessage;
      result.errorType = errorType;
      // For sync-only mode, mark as failed but it can be retried
      if (!isSyncOnly) {
        stateManager.markFailed(repoName, errorMessage, errorType);
      }
      await stateManager.save();
      return result;
    }
  }

  // All phases completed
  result.success = true;

  // For sync-only mode, keep status as completed and update lastSyncedAt
  // For new migrations, mark as completed
  if (!isSyncOnly) {
    stateManager.markCompleted(repoName);
  }
  await stateManager.save();

  console.log(`\n✓ ${isSyncOnly ? "Sync" : "Migration"} completed successfully: ${repoName}`);
  return result;
}

// CLI entry point for single repo migration
async function main() {
  const repoName = process.env.REPO_NAME;
  const githubToken = process.env.GH_SOURCE_TOKEN;
  const codebergToken = process.env.CODEBERG_TOKEN;
  const sourceOrg = process.env.GH_SOURCE_ORG;
  const targetOrg = process.env.CODEBERG_TARGET_ORG;
  const statePath = process.env.STATE_PATH ?? "./state/migration-state.json";
  const isOrg = process.env.IS_ORG === "true";

  if (!repoName || !githubToken || !codebergToken || !sourceOrg || !targetOrg) {
    console.error("Missing required environment variables:");
    console.error("  REPO_NAME, GH_SOURCE_TOKEN, CODEBERG_TOKEN, GH_SOURCE_ORG, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  const githubClient = new GitHubClient({ token: githubToken, org: sourceOrg, isOrg });
  const stateManager = new StateManager(statePath, sourceOrg, targetOrg);

  await stateManager.load();

  const repo = await githubClient.getRepo(repoName);
  if (!repo) {
    console.error(`Repo not found: ${repoName}`);
    process.exit(1);
  }

  const config: MigrationConfig = {
    githubToken,
    codebergToken,
    sourceOrg,
    targetOrg,
    statePath,
    isOrg,
  };

  const result = await migrateRepo(repo, config, stateManager);

  if (!result.success) {
    console.error(`Migration failed: ${result.error}`);
    process.exit(1);
  }

  console.log("Migration completed successfully!");
}

// Run if called directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
