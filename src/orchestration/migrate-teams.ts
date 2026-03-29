/**
 * Migrate GitHub org teams and members to Codeberg.
 *
 * Checks each GitHub member against Codeberg by username (best-effort match).
 * Users who don't have a Codeberg account with the same handle are skipped and reported.
 *
 * Env vars:
 *   GH_SOURCE_TOKEN   – GitHub PAT with read:org scope
 *   CODEBERG_TOKEN    – Codeberg PAT (owner of the Codeberg org)
 *   GH_SOURCE_ORG     – GitHub org name (e.g. "Safecast")
 *   CODEBERG_TARGET_ORG – Codeberg org name (e.g. "Safecast")
 */

import { Octokit } from "@octokit/rest";
import { execFileSync } from "child_process";
import { writeFileSync } from "fs";

const githubToken = process.env.GH_SOURCE_TOKEN!;
const codebergToken = process.env.CODEBERG_TOKEN!;
const sourceOrg = process.env.GH_SOURCE_ORG!;
const targetOrg = process.env.CODEBERG_TARGET_ORG!;
const CODEBERG_API = "https://codeberg.org/api/v1";

if (!githubToken || !codebergToken || !sourceOrg || !targetOrg) {
  console.error("Missing required env vars: GH_SOURCE_TOKEN, CODEBERG_TOKEN, GH_SOURCE_ORG, CODEBERG_TARGET_ORG");
  process.exit(1);
}

const octokit = new Octokit({ auth: githubToken });

// ── Codeberg helpers (curl-based, avoids Node fetch issues) ──────────────────

function codebergRequest<T>(method: string, path: string, body?: unknown): T {
  const args = [
    "-s", "-w", "\n%{http_code}",
    "-X", method,
    "-H", `Authorization: token ${codebergToken}`,
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json",
  ];
  if (body) args.push("-d", JSON.stringify(body));
  args.push(`${CODEBERG_API}${path}`);

  const raw = execFileSync("curl", args, { encoding: "utf-8", timeout: 30000 }).trim();
  const lines = raw.split("\n");
  const status = parseInt(lines[lines.length - 1], 10);
  const responseBody = lines.slice(0, -1).join("\n");

  if (status === 404) return null as T;
  if (status < 200 || status >= 300) {
    throw new Error(`Codeberg API ${method} ${path} → ${status}: ${responseBody}`);
  }
  return responseBody ? JSON.parse(responseBody) : ({} as T);
}

function userExistsOnCodeberg(username: string): boolean {
  const result = codebergRequest<{ login: string } | null>("GET", `/users/${username}`);
  return result !== null;
}

function getCodebergTeams(): Array<{ id: number; name: string }> {
  return codebergRequest<Array<{ id: number; name: string }>>("GET", `/orgs/${targetOrg}/teams`) ?? [];
}

function sanitizeTeamName(name: string): string {
  // Codeberg only allows alphanumeric, dash, and dot in team names
  return name.replace(/[^a-zA-Z0-9.\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function createCodebergTeam(name: string, description: string, permission: string): { id: number; name: string } {
  const safeName = sanitizeTeamName(name);
  return codebergRequest("POST", `/orgs/${targetOrg}/teams`, {
    name: safeName,
    description: description || name, // keep original name in description
    permission,
    units: ["repo.code", "repo.issues", "repo.pulls"],
  });
}

function addMemberToTeam(teamId: number, username: string): void {
  codebergRequest("PUT", `/teams/${teamId}/members/${username}`);
}

function addRepoToTeam(teamId: number, repoName: string): void {
  codebergRequest("PUT", `/teams/${teamId}/repos/${targetOrg}/${repoName}`);
}

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, retries = 5, delayMs = 2000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const transient = e?.cause?.code === "UND_ERR_SOCKET" || e?.status === 500 || e?.status === 503;
      if (transient && attempt < retries) {
        console.warn(`    Transient error, retrying (${attempt}/${retries})...`);
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      } else {
        throw e;
      }
    }
  }
  throw new Error("Unreachable");
}

async function getGitHubTeams() {
  return withRetry(() => octokit.paginate(octokit.teams.list, { org: sourceOrg, per_page: 100 }));
}

async function getTeamMembers(slug: string): Promise<string[]> {
  const members = await withRetry(() =>
    octokit.paginate(octokit.teams.listMembersInOrg, { org: sourceOrg, team_slug: slug, per_page: 100 })
  );
  return members.map((m) => m.login);
}

async function getTeamRepos(slug: string): Promise<string[]> {
  const repos = await withRetry(() =>
    octokit.paginate(octokit.teams.listReposInOrg, { org: sourceOrg, team_slug: slug, per_page: 100 })
  );
  return repos.map((r) => r.name);
}

function mapPermission(ghPermission: string): string {
  if (ghPermission === "admin") return "owner";
  if (ghPermission === "push") return "write";
  return "read";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMigrating teams from GitHub/${sourceOrg} → Codeberg/${targetOrg}\n`);

  const ghTeams = await getGitHubTeams();
  const existingCbTeams = getCodebergTeams();
  const cbTeamByName = new Map(existingCbTeams.map((t) => [t.name.toLowerCase(), t]));

  const skippedUsers: { team: string; user: string }[] = [];
  const foundUsers: Set<string> = new Set();
  const userTeams: Map<string, string[]> = new Map();

  for (const ghTeam of ghTeams) {
    console.log(`\n── Team: ${ghTeam.name} ──`);

    // Create or reuse Codeberg team
    const safeName = sanitizeTeamName(ghTeam.name);
    let cbTeam = cbTeamByName.get(safeName.toLowerCase());
    if (cbTeam) {
      console.log(`  Team already exists on Codeberg (id=${cbTeam.id})`);
    } else {
      const permission = mapPermission(ghTeam.permission ?? "pull");
      cbTeam = createCodebergTeam(ghTeam.name, ghTeam.description ?? "", permission);
      console.log(`  Created team on Codeberg (id=${cbTeam.id})`);
    }

    const teamId = cbTeam.id;

    // Members
    const members = await getTeamMembers(ghTeam.slug);
    console.log(`  Members (${members.length}): ${members.join(", ")}`);

    for (const login of members) {
      if (!userTeams.has(login)) userTeams.set(login, []);
      userTeams.get(login)!.push(ghTeam.name);

      if (foundUsers.has(login)) {
        addMemberToTeam(teamId, login);
        continue;
      }
      if (userExistsOnCodeberg(login)) {
        foundUsers.add(login);
        addMemberToTeam(teamId, login);
        console.log(`    ✓ Added ${login}`);
      } else {
        skippedUsers.push({ team: ghTeam.name, user: login });
        console.log(`    ✗ ${login} — no Codeberg account found (skipped)`);
      }
    }

    // Repos
    const repos = await getTeamRepos(ghTeam.slug);
    console.log(`  Repos (${repos.length}): ${repos.join(", ")}`);
    for (const repo of repos) {
      try {
        addRepoToTeam(teamId, repo);
        console.log(`    ✓ Linked repo ${repo}`);
      } catch (e: any) {
        console.warn(`    ✗ Could not link repo ${repo}: ${e.message}`);
      }
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Team migration summary");
  console.log("=".repeat(60));
  console.log(`Teams migrated: ${ghTeams.length}`);

  console.log(`\n✓ Users added to Codeberg (${foundUsers.size}):`);
  for (const u of [...foundUsers].sort()) {
    console.log(`  - ${u}  → https://codeberg.org/${u}`);
  }

  const uniqueSkipped = [...new Set(skippedUsers.map((s) => s.user))].sort();
  if (uniqueSkipped.length > 0) {
    console.log(`\n✗ Users NOT found on Codeberg (${uniqueSkipped.length}) — need to create an account:`);
    for (const u of uniqueSkipped) {
      const teams = skippedUsers.filter((s) => s.user === u).map((s) => s.team).join(", ");
      console.log(`  - ${u}  (GitHub: https://github.com/${u}) — was in: ${teams}`);
    }
    console.log("\nOnce they sign up on Codeberg, re-run this script to add them.");
  } else {
    console.log("\n✓ All users were found and added!");
  }

  // Write CSV report
  const csvLines = ["username,codeberg_found,codeberg_url,github_url,teams"];
  for (const u of [...foundUsers].sort()) {
    const teams = (userTeams.get(u) ?? []).join("|");
    csvLines.push(`${u},yes,https://codeberg.org/${u},https://github.com/${u},"${teams}"`);
  }
  for (const u of uniqueSkipped) {
    const teams = (userTeams.get(u) ?? []).join("|");
    csvLines.push(`${u},no,,https://github.com/${u},"${teams}"`);
  }

  const csvPath = `state/safecast-team-migration.csv`;
  writeFileSync(csvPath, csvLines.join("\n") + "\n");
  console.log(`\nCSV report written to: ${csvPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
