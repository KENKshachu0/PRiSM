import { assertDeploymentBranch } from "./deployment-branch";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken, sha256 } from "../packages/server/src/crypto";
import { deploymentHealth, deploymentRequest } from "./deployment-control-client";
import { deploymentControlPath } from "../packages/server/src/deployment-gate";
import { deployPlatform, type PlatformDeploymentSteps } from "./deploy-platform-flow";

assertDeploymentBranch(process.env);

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(root, "wrangler.generated.jsonc");
const base = await Bun.file(configPath).json();
if (base.main !== "packages/server/src/worker.ts" || !base.vars?.APP_ORIGIN)
  throw new Error("Generate the platform configuration before running this script");
const origin = new URL(base.vars.APP_ORIGIN);
if (origin.protocol !== "https:" || origin.origin !== base.vars.APP_ORIGIN)
  throw new Error("A production HTTPS APP_ORIGIN is required");
const packageJson = await Bun.file(resolve(root, "package.json")).json();
if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error("Invalid release version");
const revision = (await command(["git", "rev-parse", "HEAD"], true)).trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Cannot determine release revision");
const token = randomToken(48), tokenHash = await sha256(token);
const files = (await readdir(resolve(root, "migrations"))).filter(name => name.endsWith(".sql"))
  .sort((a, b) => parseInt(a) - parseInt(b) || (a < b ? -1 : a > b ? 1 : 0));
if (files.some(name => !/^\d+_[a-z0-9_-]+\.sql$/.test(name))) throw new Error("Unsupported migration filename");
await mkdir(resolve(root, ".wrangler"), { recursive: true });
const folder = await mkdtemp(resolve(root, ".wrangler/platform-deploy-"));
const configs = new Map<string, string>();
for (const phase of ["maintenance", "verify", "live"] as const) {
  const config = {
    ...base,
    main: resolve(root, phase === "maintenance" ? "packages/server/src/maintenance-worker.ts" : "packages/server/src/worker.ts"),
    assets: { ...base.assets, binding: "ASSETS", directory: resolve(root, base.assets.directory), run_worker_first: phase === "live" ? [...base.assets.run_worker_first, deploymentControlPath] : true },
    d1_databases: base.d1_databases.map((db: Record<string, unknown>) => ({ ...db, migrations_dir: resolve(root, "migrations") })),
    vars: { ...base.vars, PRISM_DEPLOY_GUARD: "1", PRISM_DEPLOY_PHASE: phase, PRISM_DEPLOY_TOKEN_HASH: tokenHash, PRISM_DEPLOY_REVISION: revision },
  };
  const path = resolve(folder, `${phase}.json`);
  await Bun.write(path, JSON.stringify(config, null, 2));
  configs.set(phase, path);
}
const deploymentArgs = (phase: string) => ["wrangler", "deploy", "--config", configs.get(phase)!,
  "--define", `PRISM_BACKEND_VERSION:${JSON.stringify(packageJson.version)}`,
  "--define", `PRISM_BACKEND_REVISION:${JSON.stringify(revision.slice(0, 12))}`];

const controlOptions = { origin, token, revision, sleep: (milliseconds: number) => Bun.sleep(milliseconds) };
let activePhase: string | undefined;
const control = (body: Record<string, unknown>) => deploymentRequest(controlOptions, body, activePhase);

const steps: PlatformDeploymentSteps = {
  async preflight() {
    // Compile every phase before changing the live Worker or database.
    for (const phase of configs.keys()) await command([...deploymentArgs(phase), "--dry-run"]);
  },
  async deploy(phase) {
    console.log(`Deploying ${phase} phase for ${base.name} (${revision.slice(0, 12)})`);
    await command(deploymentArgs(phase));
    console.log(`Waiting for authenticated ${phase} phase at ${origin.origin}`);
    await deploymentRequest(controlOptions, { action: "probe" }, phase);
    activePhase = phase;
    console.log(`Confirmed ${phase} phase (${revision.slice(0, 12)})`);
  },
  async control(action) {
    await control({ action });
  },
  async checkpoint() {
    // Capture after fencing: no later business writes can be lost by restoring this bookmark.
    const data = JSON.parse(await command(["wrangler", "d1", "time-travel", "info", "DB", "--config", configPath, "--json"], true)) as { bookmark?: string };
    if (!data.bookmark) throw new Error("D1 recovery bookmark was not returned");
    await Bun.write(resolve(folder, "recovery.json"), JSON.stringify({ worker: base.name, databaseId: base.d1_databases[0].database_id, revision, ...data }, null, 2));
    console.log(`D1 recovery bookmark: ${data.bookmark} (retain this deployment log for recovery)`);
  },
  async migrate() {
    // Use the same ledger/names as Wrangler, but keep SQL and write-fence restoration
    // inside one D1 batch. Direct wrangler migrations apply would bypass this protection.
    for (const name of files) {
      await control({ action: "schema", name, sql: await Bun.file(resolve(root, "migrations", name)).text() });
      console.log(`Migration checked/applied: ${name}`);
    }
  },
  async health() {
    await deploymentHealth(controlOptions);
    console.log("Deployment verified; business requests resumed.");
  },
};
if (Bun.argv.includes("--dry-run")) await steps.preflight();
else await deployPlatform(steps);

async function command(args: string[], capture = false): Promise<string> {
  const process = Bun.spawn(args, { cwd: root, stdout: capture ? "pipe" : "inherit", stderr: "inherit", stdin: "ignore" });
  const output = capture ? await new Response(process.stdout).text() : "";
  const status = await process.exited;
  if (status !== 0) throw new Error(`${args.join(" ")} failed (exit ${status})`);
  return output;
}
