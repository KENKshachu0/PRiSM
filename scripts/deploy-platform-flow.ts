export type PlatformDeploymentSteps = {
  preflight(): Promise<void>;
  deploy(phase: "maintenance" | "verify" | "live"): Promise<void>;
  control(action: "begin" | "convert" | "check" | "resume" | "block"): Promise<void>;
  checkpoint(): Promise<void>;
  migrate(): Promise<void>;
  health(): Promise<void>;
};

/** Name the failing step so the CI log shows where the rollout stopped. */
async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Deployment step "${label}" failed: ${detail}`, { cause: error });
  }
}

/** No finally/resume: a failed migration or rollout must leave the database fenced. */
export async function deployPlatform(steps: PlatformDeploymentSteps): Promise<void> {
  await step("preflight", () => steps.preflight());
  let maintenanceInstalled = false;
  try {
    await step("deploy maintenance", () => steps.deploy("maintenance"));
    maintenanceInstalled = true;
    await step("control begin", () => steps.control("begin"));
    await step("checkpoint", () => steps.checkpoint());
    await step("migrate", () => steps.migrate());
    await step("deploy verify", () => steps.deploy("verify"));
    await step("control convert", () => steps.control("convert"));
    await step("control check", () => steps.control("check"));
    await step("deploy live", () => steps.deploy("live"));
    await step("control resume", () => steps.control("resume"));
    await step("health", () => steps.health());
  } catch (error) {
    if (maintenanceInstalled) {
      try { await steps.control("block"); }
      catch { throw new Error("Deployment failed; unable to confirm maintenance. Check the target Worker before retrying.", { cause: error }); }
    }
    throw error;
  }
}
