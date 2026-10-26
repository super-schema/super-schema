/**
 * The password sign-in decision: what Auth.js's credentials `authorize` calls (src/lib/auth.ts). Everything a sign-in must hide is decided here.
 *
 * ONE answer for every refusal: `null`. An unknown e-mail, a wrong password, an account with no password, a DISABLED account and a LOCKED e-mail or
 * address are not told apart by the value, by the login page's words (`INVALID_CREDENTIALS_MESSAGE`), or by how long the answer takes: a bcrypt
 * compare always runs (`verifyPassword`: the stored hash when there is one to try, the dummy hash otherwise; a locked attempt is compared against
 * the dummy, so the lock does not show in the time, and its account is not even looked up).
 *
 * Every attempt is written down, by hash (src/lib/auth/throttle.ts): a failure counts toward the lock, a success resets the e-mail's count, an
 * attempt refused because of the lock is `locked` and does not count. Writing it down is best effort for a success (a problem with the log never blocks
 * a sign-in) and for a failure (the answer is a refusal already). Reading the throttle fails CLOSED: a throttle that cannot be read refuses.
 */
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password-hash";
import { normalizeEmail } from "@/lib/auth/password-policy";
import { isThrottled, recordAuthEvent, type AuthEventOutcome } from "@/lib/auth/throttle";

export type PasswordLogin = { id: string; email: string; name: string | null };

async function recordLogin(event: { email?: string; ip: string; outcome: AuthEventOutcome }): Promise<void> {
  try {
    await recordAuthEvent("login", event);
  } catch (error) {
    console.error(`[auth] could not record a login ${event.outcome} event`, error);
  }
}

/**
 * @param input.email what was typed (any type: it comes from a form), normalized here
 * @param input.password what was typed
 * @param input.ip the client address bucket of the request (`clientIp`)
 * @returns the user to sign in, or null
 */
export async function authenticateWithPassword(input: { email: unknown; password: unknown; ip: string }): Promise<PasswordLogin | null> {
  const email = normalizeEmail(typeof input.email === "string" ? input.email : "");
  const password = typeof input.password === "string" ? input.password : "";
  const { ip } = input;

  // Nothing to look up: still the same work (and a failure against the address, so a flood of empty forms is limited too).
  if (email === "" || password === "") {
    await verifyPassword(password, null);
    await recordLogin({ ip, outcome: "failure", ...(email !== "" ? { email } : {}) });
    return null;
  }

  let locked: boolean;
  try {
    locked = (await isThrottled({ email, ip, kind: "login" })).throttled;
  } catch (error) {
    console.error("[auth] could not read the login throttle; refusing the attempt", error);
    locked = true;
  }
  if (locked) {
    await verifyPassword(password, null);
    await recordLogin({ email, ip, outcome: "locked" });
    return null;
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const matches = await verifyPassword(password, user?.password);
  if (!user || !matches || user.disabledAt !== null) {
    await recordLogin({ email, ip, outcome: "failure" });
    return null;
  }
  await recordLogin({ email, ip, outcome: "success" });
  return { id: user.id, email: user.email, name: user.name };
}
