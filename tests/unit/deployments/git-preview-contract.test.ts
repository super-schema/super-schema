import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { freezeArtifact } from "@/lib/deployments/artifact";
import { WorkflowSettingsSchema } from "@/lib/deployments/contracts";
const h = vi.hoisted(() => ({ branchExists: vi.fn(), verify: vi.fn(), base: vi.fn(), tree: vi.fn(), readFiles: vi.fn(), deliver: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/deployments/github", () => ({ GitHubClient: class { branchExists = h.branchExists; verify = h.verify; base = h.base; tree = h.tree; readFiles = h.readFiles; deliver = h.deliver; } }));
vi.mock("@/lib/deployments/event-contract", () => ({ prepareEventContract: h.event }));
import { deliverPrepared, prepareDelivery } from "@/lib/deployments/adapters";
const entity = { id: "account", name: "Account", tenant: "tenant", domain: "identity", product: "accounts", schema: "account" };
const bundle = () => freezeArtifact(entity, "avro", { version: 3, status: "published", output: '{"type":"record","name":"Account","fields":[]}', entityVersion: 2, generatedAt: "2026-11-10" });
const files = [{ path: "schemas/tenant/identity/accounts/product-manifest.json", content: '{"version":2}\n' }, { path: "schemas/tenant/identity/accounts/account/1.0.0_snapshot/account.avsc", content: '{"name":"Account"}\n' }];
const baseline = [{ path: files[0].path, content: '{"version":1}\n' }];
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-12T18:30:00Z")); h.branchExists.mockResolvedValue(false); h.verify.mockResolvedValue({}); h.base.mockResolvedValue("base-sha");
  h.tree.mockResolvedValue([{ path: files[0].path, sha: "old-blob", type: "blob", mode: "100644" }]);
  h.readFiles.mockImplementation(async (_base, select: (path: string) => boolean) => baseline.filter((file) => select(file.path)));
  h.event.mockResolvedValue({ files, validation: ["Contract validated"] });
  h.deliver.mockResolvedValue({ outcome: "pr-opened", prNumber: 7 });
});
afterEach(() => { vi.useRealTimers(); });
const prepare = (title = "") => prepareDelivery({ id: "run", method: "git", bundle: bundle(), config: { url: "https://github.com/acme/contracts", baseBranch: "main", supportsIdempotency: false }, settings: WorkflowSettingsSchema.parse({ eventContract: true, title }), revision: 1, environment: "staging" }, { authType: "none" });
it("freezes the complete PR file set, before-content and generated title, and sends those exact files", async () => {
  const plan = await prepare();
  expect(plan.baseSha).toBe("base-sha");
  expect(plan.files).toEqual(files);
  expect(plan.fileChanges).toEqual([{ path: files[0].path, status: "modified", before: baseline[0].content }, { path: files[1].path, status: "added" }]);
  expect(plan.settings.title).toBe("Publish account: avro v3 → staging (1.0.0_snapshot)");
  expect(h.deliver).not.toHaveBeenCalled();
  await deliverPrepared("run", "git", plan, { authType: "none" }, "intent");
  expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ baseSha: "base-sha", files: plan.files, title: plan.settings.title }));
});
it("uses an edited title in both the preview and submitted PR", async () => {
  const plan = await prepare("Review account contract");
  await deliverPrepared("run", "git", plan, { authType: "none" }, "intent");
  expect(plan.settings.title).toBe("Review account contract");
  expect(h.deliver.mock.calls[0][0].title).toBe("Review account contract");
});
it("refuses execution if every planned file is unchanged", async () => {
  const plan = await prepare();
  plan.fileChanges = plan.files!.map((file) => ({ path: file.path, status: "unchanged" as const, before: file.content }));
  await expect(deliverPrepared("run", "git", plan, { authType: "none" }, "intent")).rejects.toThrow(/no file changes/);
  expect(h.deliver).not.toHaveBeenCalled();
});

it("names the branch <schema>-<contract version>-<YYYY-MM-DD> and appends a counter when that day's name is taken", async () => {
  expect((await prepare()).branch).toBe("account-1.0.0_snapshot-2026-11-12");
  h.branchExists.mockImplementation(async (name: string) => name === "account-1.0.0_snapshot-2026-11-12");
  expect((await prepare()).branch).toBe("account-1.0.0_snapshot-2026-11-12-2");
});
it("writes generic Git files under the repository root without tenant or format directories", async () => {
  h.tree.mockResolvedValue([]);
  const plan = await prepareDelivery({ id: "run", method: "git", bundle: bundle(), config: { url: "https://github.com/acme/contracts", baseBranch: "development", gitRoot: "event-schemas", supportsIdempotency: false }, settings: WorkflowSettingsSchema.parse({}), revision: 1, environment: "development" }, { authType: "none" });
  expect(h.base).toHaveBeenCalledWith("development");
  expect(plan.files!.map((f) => f.path)).toEqual(["event-schemas/identity/accounts/account/1.0.0_snapshot/account.schema.avsc", "event-schemas/identity/accounts/account/1.0.0_snapshot/.superschema/avro.manifest.json"]);
});
it("refuses to overwrite a different file another target wrote at the same path", async () => {
  const path = "identity/accounts/account/1.0.0_snapshot/account.schema.avsc";
  h.tree.mockResolvedValue([{ path, sha: "x", type: "blob", mode: "100644" }]);
  h.readFiles.mockResolvedValue([{ path, content: "other" }]);
  await expect(prepareDelivery({ id: "run", method: "git", bundle: bundle(), config: { url: "https://github.com/acme/contracts", baseBranch: "main", supportsIdempotency: false }, settings: WorkflowSettingsSchema.parse({}), revision: 1, environment: "development" }, { authType: "none" })).rejects.toThrow(/Another target already wrote/);
});
