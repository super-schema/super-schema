import type { EnvironmentDetails } from "./contracts";

/** UTC calendar day, YYYY-MM-DD. */
export const branchDate = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/**
 * Short, readable delivery branch: `<schema>-<contractVersion>-<YYYY-MM-DD>`, with `-2`, `-3`… appended
 * when an earlier delivery already used the name that day.
 */
export function deliveryBranchName(input: { schema: string; contractVersion: string; date: string; attempt?: number }): string {
  const name = `${input.schema}-${input.contractVersion}-${input.date}`;
  return input.attempt && input.attempt > 1 ? `${name}-${input.attempt}` : name;
}

/** Default branch for an environment, matching GitOps stage defaults: "Pre Prod" → "pre-prod". */
export const environmentBranchSlug = (environment: string): string => environment.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "main";

/** An environment's Git base branch: its configured override, otherwise a branch named after the environment. */
export function gitBranchForEnvironment(details: EnvironmentDetails | undefined, environment: string): { branch: string; overridden: boolean } {
  const override = details?.[environment]?.branch?.trim();
  return override ? { branch: override, overridden: true } : { branch: environmentBranchSlug(environment), overridden: false };
}
