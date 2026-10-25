/**
 * Runs once when the Next.js server starts (`next start`, `next dev`, the standalone server): the one place that can refuse to start.
 *
 * A production server whose session secret is missing, shorter than 32 characters, or a known development value (the compose file used to
 * ship `dev-secret-change-in-production`) would accept a login forged by anyone who has read the repository: the secret is the whole
 * authentication boundary. So it does not start, with the reason and how to make a secret (`openssl rand -base64 32`). Development and test
 * are never affected. The refusal ENDS the process (exit code 1): a throw from this hook leaves `next start` listening and answering 500 to everything.
 * `next build` does not run this (there is no secret at build time and none is needed).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { refuseToStartWithoutProductionSecret } = await import("@/lib/auth-secret");
  // Ends the process: a throw here leaves `next start` listening and answering 500 to every request.
  refuseToStartWithoutProductionSecret();
}
