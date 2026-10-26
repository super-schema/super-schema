/**
 * The Auth.js `signIn` callback for an identity provider (everything but the local credentials), access-control Task 8b: what Auth.js calls with the REAL
 * profile after the provider has authenticated the person and BEFORE it touches the database (`handleAuthorized` runs before `handleLoginOrRegister`, so
 * a refusal here means no user is ever created, linked or updated by that sign-in).
 *
 * It asks the pure decision (`evaluateProviderSignIn`, src/lib/auth/provider-signin.ts) with what the database says: the user the provider account is
 * ALREADY LINKED to (the stable provider account id, which is what Auth.js itself signs in), else the user with the normalized e-mail (`normalizeEmail`: how
 * every account is stored), else nobody.
 *
 *   - ONE answer for every refusal: `false`, which Auth.js turns into a redirect to the login page, where the words are those of a wrong password
 *     (`INVALID_CREDENTIALS_MESSAGE`). Which rule refused is in the event, not in the answer, the words or the time it took beyond what the database does.
 *   - A refusal is an `auth_events` row: kind `provider_refused:<reason>`, outcome `refused`, the e-mail and the address as keyed hashes only
 *     (`recordAuthEvent`). A success is `provider_login` / `success` and `users.lastLoginAt`.
 *   - Throttled per client address with the Task 4 bucket (`isThrottled`, kind `provider_refused`: 5 refusals in 15 minutes, the shared ceiling without a
 *     trusted proxy). A locked address is refused before anything is read, and the throttle failing to answer refuses (fail closed). The address is the
 *     request's own (`requestIp`: `X-Forwarded-For` only with `AUTH_TRUST_PROXY=1`); the callback runs inside the route handler of the request, so the
 *     headers are there. Without them the shared bucket is used.
 *   - A database that cannot answer refuses and logs: "nobody found" because of an error must never mean "let through". Recording an event is best effort
 *     and never changes the answer.
 *
 * Nothing here creates a user, and nothing it calls does: see `guardAdapter` (src/lib/auth/adapter-guard.ts), which makes Auth.js's own `createUser` refuse
 * too. The docs say the rest (docs/auth.md).
 */
import { prisma } from "@/lib/db";
import { enabledProviders } from "@/lib/auth/providers";
import { normalizeEmail } from "@/lib/auth/password-policy";
import { evaluateProviderSignIn, type ExistingUser, type ProviderPolicy } from "@/lib/auth/provider-signin";
import { requestIp } from "@/lib/auth/request-guard";
import { UNTRUSTED_IP, isThrottled, recordAuthEvent, type AuthEventKind, type AuthEventOutcome } from "@/lib/auth/throttle";

type FoundUser = { id: string; disabledAt: Date | null };

/** What the callback uses, so a test can hand it stubs. The defaults are the real ones. */
export type ProviderCallbackDeps = {
  prisma: {
    account: {
      findUnique(args: {
        where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
        select: { user: { select: { id: true; disabledAt: true } } };
      }): Promise<{ user: FoundUser } | null>;
    };
    user: {
      findUnique(args: { where: { email: string }; select: { id: true; disabledAt: true } }): Promise<FoundUser | null>;
      updateMany(args: { where: { id: string }; data: { lastLoginAt: Date } }): Promise<unknown>;
    };
  };
  /** The policies of the enabled providers (the registry). */
  providers: () => readonly ProviderPolicy[];
  clientIp: () => Promise<string>;
  isThrottled: typeof isThrottled;
  recordAuthEvent: typeof recordAuthEvent;
};

const defaultDeps: ProviderCallbackDeps = {
  prisma: prisma as unknown as ProviderCallbackDeps["prisma"],
  providers: () => enabledProviders().map((enabled) => enabled.policy),
  clientIp: requestIp,
  isThrottled,
  recordAuthEvent,
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Writes an event; a problem with the log never changes the answer. */
async function record(deps: ProviderCallbackDeps, kind: AuthEventKind, event: { email?: string; ip: string; outcome: AuthEventOutcome }): Promise<void> {
  try {
    await deps.recordAuthEvent(kind, event);
  } catch (error) {
    console.error(`[auth] could not record a ${kind} event`, error);
  }
}

/**
 * @param input.account Auth.js's account of this sign-in (`provider`, `providerAccountId`)
 * @param input.profile the provider's profile (ID token claims or the user-info response)
 * @returns true to let Auth.js go on (the user exists; it signs them in or links the account), false to refuse
 */
export async function authorizeProviderSignIn(
  input: { account: { provider?: unknown; providerAccountId?: unknown } | null | undefined; profile: unknown },
  deps: ProviderCallbackDeps = defaultDeps,
): Promise<boolean> {
  const provider = typeof input.account?.provider === "string" ? input.account.provider : "";
  const providerAccountId = typeof input.account?.providerAccountId === "string" ? input.account.providerAccountId : "";
  const profile = isRecord(input.profile) ? input.profile : null;
  const email = normalizeEmail(typeof profile?.email === "string" ? profile.email : "");
  const loggedEmail = email !== "" ? { email } : {};

  let ip = UNTRUSTED_IP;
  try {
    ip = await deps.clientIp();
  } catch {
    // No request in scope: the shared bucket (the callback always runs inside a request; this is a unit test or a misuse).
  }

  let locked: boolean;
  try {
    locked = (await deps.isThrottled({ ip, kind: "provider_refused" })).throttled;
  } catch (error) {
    console.error("[auth] could not read the provider sign-in throttle; refusing the attempt", error);
    locked = true;
  }
  if (locked) {
    await record(deps, "provider_refused:throttled", { ...loggedEmail, ip, outcome: "locked" });
    return false;
  }

  const policies = deps.providers();
  let existing: (FoundUser & { linked: boolean }) | null = null;
  // Only a provider that is enabled and a profile with an e-mail are worth a look at the database: the decision refuses the rest on its own.
  if (provider !== "" && email !== "" && policies.some((policy) => policy.id === provider)) {
    try {
      const linked =
        providerAccountId !== ""
          ? await deps.prisma.account.findUnique({
              where: { provider_providerAccountId: { provider, providerAccountId } },
              select: { user: { select: { id: true, disabledAt: true } } },
            })
          : null;
      if (linked) existing = { ...linked.user, linked: true };
      else {
        const byEmail = await deps.prisma.user.findUnique({ where: { email }, select: { id: true, disabledAt: true } });
        if (byEmail) existing = { ...byEmail, linked: false };
      }
    } catch (error) {
      console.error("[auth] could not look up the user of a provider sign-in; refusing it", error);
      return false;
    }
  }

  const existingUser: ExistingUser = existing ? { disabled: existing.disabledAt !== null, linked: existing.linked } : null;
  const decision = evaluateProviderSignIn({ provider, profile, config: { enabled: policies }, existingUser });

  if (!decision.allow) {
    await record(deps, `provider_refused:${decision.reason}`, { ...loggedEmail, ip, outcome: "refused" });
    return false;
  }

  // Allowed, so `existing` is a user (the decision refuses `no-account`).
  try {
    await deps.prisma.user.updateMany({ where: { id: existing!.id }, data: { lastLoginAt: new Date() } });
  } catch (error) {
    console.error("[auth] could not record lastLoginAt", error);
  }
  await record(deps, "provider_login", { ...loggedEmail, ip, outcome: "success" });
  return true;
}
