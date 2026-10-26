/**
 * `guardAdapter` (src/lib/auth/adapter-guard.ts): nobody signs up through an identity provider. Auth.js's own OAuth flow ends in `createUser` for an
 * e-mail it does not know, and it looks an e-mail up with the exact text the provider sent (`John@Corp.com`), which finds nothing in a table of
 * lower-case addresses and so falls through to `createUser`. The guard makes the look-up normalize and makes `createUser` refuse, whatever the policy
 * said, so a mistake in the policy (or a flow the policy never saw) cannot create an account.
 */
import { describe, expect, it, vi } from "vitest";
import type { Adapter } from "next-auth/adapters";
import { ProviderSignUpRefused, guardAdapter } from "@/lib/auth/adapter-guard";

function stubAdapter() {
  const spies = {
    createUser: vi.fn(async (user: unknown) => user),
    getUser: vi.fn<(id: string) => Promise<null>>(async () => null),
    getUserByEmail: vi.fn<(email: string) => Promise<null>>(async () => null),
    getUserByAccount: vi.fn<(account: unknown) => Promise<null>>(async () => null),
    linkAccount: vi.fn(async (account: unknown) => account),
    updateUser: vi.fn(async (user: unknown) => user),
  };
  return { spies, adapter: spies as unknown as Adapter };
}

describe("guardAdapter", () => {
  it("createUser refuses and never reaches the adapter", async () => {
    const { adapter, spies } = stubAdapter();
    const guarded = guardAdapter(adapter);
    await expect(guarded.createUser!({ id: "x", email: "stranger@example.com", emailVerified: null })).rejects.toBeInstanceOf(ProviderSignUpRefused);
    expect(spies.createUser).not.toHaveBeenCalled();
  });

  it("the refusal says what happened, for the log (the visitor sees the generic login failure)", async () => {
    const guarded = guardAdapter(stubAdapter().adapter);
    await expect(guarded.createUser!({ id: "x", email: "a@b.test", emailVerified: null })).rejects.toThrow(/no account is created by a sign-in/i);
  });

  it("getUserByEmail looks up the NORMALIZED address (how every account is stored)", async () => {
    const { adapter, spies } = stubAdapter();
    await guardAdapter(adapter).getUserByEmail!("  John@Corp.COM ");
    expect(spies.getUserByEmail).toHaveBeenCalledWith("john@corp.com");
  });

  it("every other method is the adapter's own", async () => {
    const { adapter, spies } = stubAdapter();
    const guarded = guardAdapter(adapter);
    await guarded.getUser!("u1");
    await guarded.getUserByAccount!({ provider: "keycloak", providerAccountId: "kc-1" });
    await guarded.linkAccount!({ userId: "u1", type: "oidc", provider: "keycloak", providerAccountId: "kc-1" });
    await guarded.updateUser!({ id: "u1", name: "Ada" });
    expect(spies.getUser).toHaveBeenCalledWith("u1");
    expect(spies.getUserByAccount).toHaveBeenCalledWith({ provider: "keycloak", providerAccountId: "kc-1" });
    expect(spies.linkAccount).toHaveBeenCalledTimes(1);
    expect(spies.updateUser).toHaveBeenCalledTimes(1);
  });

  it("does not change the adapter it is given", () => {
    const { adapter, spies } = stubAdapter();
    guardAdapter(adapter);
    expect(adapter.createUser).toBe(spies.createUser);
  });
});
