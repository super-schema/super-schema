import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  revalidatePath: vi.fn(),
  getActiveTenantId: vi.fn(),
  resolveCurrentUserId: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
  setChannelMessages: vi.fn(),
  deleteChannel: vi.fn(),
  createTrait: vi.fn(),
  updateTrait: vi.fn(),
  deleteTrait: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: h.getActiveTenantId }));
vi.mock("@/lib/current-user", () => ({ resolveCurrentUserId: h.resolveCurrentUserId }));
vi.mock("@/services/rbac.service", () => ({ getEffectiveRole: vi.fn().mockResolvedValue({ success: true, data: "AUTHOR" }) }));
vi.mock("@/services/events/channel.service", () => ({
  createChannel: h.createChannel, updateChannel: h.updateChannel, setChannelMessages: h.setChannelMessages, deleteChannel: h.deleteChannel,
}));
vi.mock("@/services/events/trait.service", () => ({ createTrait: h.createTrait, updateTrait: h.updateTrait, deleteTrait: h.deleteTrait }));

import {
  createChannelAction,
  deleteChannelAction,
  setChannelMessagesAction,
  updateChannelAction,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/channel-actions";
import { createTraitAction, deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";

const CTX = { userId: "user-1", userRole: "AUTHOR", prisma: { tag: "prisma" } };
const INPUT = { name: "orders", address: "a", protocol: "kafka", format: "avro" };
const OK = { success: true, data: { id: "c1" } };
const FAIL = { success: false, error: { code: "FORBIDDEN", message: "read-only", details: { x: 1 } } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "user-1" } });
  h.getActiveTenantId.mockResolvedValue("tenant-active");
  h.resolveCurrentUserId.mockResolvedValue("user-1");
});

describe("channel actions", () => {
  it("rejects unauthenticated calls without touching the service", async () => {
    h.auth.mockResolvedValue(null);
    expect(await createChannelAction("p1", INPUT)).toEqual({ success: false, error: "Not authenticated", code: "UNAUTHORIZED" });
    expect(h.createChannel).not.toHaveBeenCalled();
  });

  it("rejects every unauthenticated channel action without a service call or revalidate", async () => {
    h.auth.mockResolvedValue(null);
    const notAuthenticated = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
    expect(await updateChannelAction("c1", "p1", INPUT)).toEqual(notAuthenticated);
    expect(await setChannelMessagesAction("c1", "p1", ["m1"])).toEqual(notAuthenticated);
    expect(await deleteChannelAction("c1", "p1")).toEqual(notAuthenticated);
    for (const fn of [h.updateChannel, h.setChannelMessages, h.deleteChannel, h.revalidatePath]) expect(fn).not.toHaveBeenCalled();
  });

  it("returns failures from every channel action and never revalidates", async () => {
    for (const fn of [h.createChannel, h.updateChannel, h.setChannelMessages, h.deleteChannel]) fn.mockResolvedValue(FAIL);
    const expected = { success: false, error: "read-only", code: "FORBIDDEN", details: { x: 1 } };
    expect(await createChannelAction("p1", INPUT)).toEqual(expected);
    expect(await updateChannelAction("c1", "p1", INPUT)).toEqual(expected);
    expect(await setChannelMessagesAction("c1", "p1", ["m1"])).toEqual(expected);
    expect(await deleteChannelAction("c1", "p1")).toEqual(expected);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes the product owner target and revalidates the /schemas layout on success", async () => {
    for (const fn of [h.createChannel, h.updateChannel, h.setChannelMessages, h.deleteChannel]) fn.mockResolvedValue(OK);
    expect(await createChannelAction("p1", INPUT)).toEqual({ success: true, data: { id: "c1" } });
    expect(h.createChannel).toHaveBeenCalledWith("p1", INPUT, CTX);
    await updateChannelAction("c1", "p1", INPUT);
    expect(h.updateChannel).toHaveBeenCalledWith("c1", INPUT, { level: "PRODUCT", productId: "p1" }, CTX);
    await setChannelMessagesAction("c1", "p1", ["m1"]);
    expect(h.setChannelMessages).toHaveBeenCalledWith("c1", ["m1"], { level: "PRODUCT", productId: "p1" }, CTX);
    await deleteChannelAction("c1", "p1");
    expect(h.revalidatePath.mock.calls).toEqual(Array(4).fill(["/schemas", "layout"]));
  });

  it("returns service errors with code + details and does not revalidate", async () => {
    h.updateChannel.mockResolvedValue(FAIL);
    expect(await updateChannelAction("c1", "p2", INPUT)).toEqual({ success: false, error: "read-only", code: "FORBIDDEN", details: { x: 1 } });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("trait actions", () => {
  it("never trusts a client tenant id for TENANT targets", async () => {
    h.createTrait.mockResolvedValue(OK);
    h.updateTrait.mockResolvedValue(OK);
    h.deleteTrait.mockResolvedValue(OK);
    const input = { name: "CloudEvents", kind: "MESSAGE" as const };
    await createTraitAction({ level: "TENANT", tenantId: "spoofed" }, input);
    expect(h.createTrait).toHaveBeenCalledWith({ level: "TENANT", tenantId: "tenant-active" }, input, CTX);
    await updateTraitAction("t1", { level: "TENANT", tenantId: "spoofed" }, { name: "CloudEvents" });
    expect(h.updateTrait).toHaveBeenCalledWith("t1", { name: "CloudEvents" }, { level: "TENANT", tenantId: "tenant-active" }, CTX);
    await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" });
    expect(h.deleteTrait).toHaveBeenCalledWith("t1", { level: "DOMAIN", domainId: "d1" }, CTX);
    expect(h.revalidatePath).toHaveBeenCalledTimes(3);
  });

  it("rejects unauthenticated calls with NOT_AUTHENTICATED: no service call, no tenant lookup, no revalidate", async () => {
    h.auth.mockResolvedValue(null);
    const notAuthenticated = { success: false, error: "Not authenticated", code: "UNAUTHORIZED" };
    const input = { name: "CloudEvents", kind: "MESSAGE" as const };
    expect(await createTraitAction({ level: "TENANT", tenantId: "t" }, input)).toEqual(notAuthenticated);
    expect(await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" })).toEqual(notAuthenticated);
    expect(await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" })).toEqual(notAuthenticated);
    for (const fn of [h.createTrait, h.updateTrait, h.deleteTrait, h.getActiveTenantId, h.revalidatePath]) expect(fn).not.toHaveBeenCalled();
  });

  it("returns service failures with code + details and does not revalidate", async () => {
    for (const fn of [h.createTrait, h.updateTrait, h.deleteTrait]) fn.mockResolvedValue(FAIL);
    const expected = { success: false, error: "read-only", code: "FORBIDDEN", details: { x: 1 } };
    expect(await createTraitAction({ level: "DOMAIN", domainId: "d1" }, { name: "x", kind: "OPERATION" })).toEqual(expected);
    expect(await updateTraitAction("t1", { level: "DOMAIN", domainId: "d1" }, { name: "x" })).toEqual(expected);
    expect(await deleteTraitAction("t1", { level: "DOMAIN", domainId: "d1" })).toEqual(expected);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  it("passes a malformed (non-object) target through untouched so the service rejects it instead of the action throwing", async () => {
    h.createTrait.mockResolvedValue({ success: false, error: { code: "VALIDATION_ERROR", message: "Scope target must be an object" } });
    const result = await createTraitAction(null as never, { name: "x", kind: "MESSAGE" });
    expect(result).toEqual({ success: false, error: "Scope target must be an object", code: "VALIDATION_ERROR" });
    expect(h.createTrait).toHaveBeenCalledWith(null, { name: "x", kind: "MESSAGE" }, CTX);
    expect(h.getActiveTenantId).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
