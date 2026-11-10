import { beforeEach, describe, expect, it, vi } from "vitest";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/deployments/http", () => ({ externalJson: call, authHeaders: () => ({ Authorization: "Bearer test" }) }));
import { RegistryClient, registryNodes } from "@/lib/deployments/registry";
import { freezeArtifact } from "@/lib/deployments/artifact";
import { WorkflowSettingsSchema } from "@/lib/deployments/contracts";
const entity = { id: "root", name: "Account", tenant: "paypal", domain: "identity", product: "accounts", schema: "account" };
const settings = () => WorkflowSettingsSchema.parse({ subject: "account-value", referenceSubjects: { "Address.json": "address-value", "Address.avsc": "address-value" } });
const bundle = (format: string, files: { path: string; content: string }[]) => freezeArtifact(entity, format, { version: 2, status: "published", output: "unused", entityVersion: 1, generatedAt: "now", files: files.map((f, i) => ({ ...f, target: format as "avro", entityId: i === 0 ? "root" : "address" })) });
beforeEach(() => { call.mockReset(); });

describe("registry registration", () => {
  it("registers only the root when Avro definitions are self-contained", () => {
    const b = bundle("avro", [
      { path: "Account.avsc", content: JSON.stringify({ type: "record", name: "Account", fields: [{ name: "address", type: { type: "record", name: "Address", fields: [] } }] }) },
      { path: "Address.avsc", content: JSON.stringify({ type: "record", name: "Address", fields: [] }) },
    ]);
    expect(registryNodes(b, WorkflowSettingsSchema.parse({ subject: "account" })).map((n) => n.path)).toEqual(["Account.avsc"]);
  });
  it("orders JSON Schema dependencies before their parent", () => {
    const b = bundle("json-schema", [{ path: "Account.json", content: '{"type":"object","properties":{"address":{"$ref":"Address.json"}}}' }, { path: "Address.json", content: '{"type":"object"}' }]);
    expect(registryNodes(b, settings()).map((n) => n.path)).toEqual(["Address.json", "Account.json"]);
  });
  it("requires explicit subjects for external dependencies and rejects missing references", () => {
    const b = bundle("json-schema", [{ path: "Account.json", content: '{"$ref":"Address.json"}' }, { path: "Address.json", content: '{}' }]);
    expect(() => registryNodes(b, WorkflowSettingsSchema.parse({ subject: "root" }))).toThrow(/subject for dependency/);
    expect(() => registryNodes(bundle("json-schema", [{ path: "Account.json", content: '{"$ref":"Missing.json"}' }]), settings())).toThrow(/missing from the frozen/);
  });
  it("refuses cyclic separate references and formats the registry does not support", () => {
    const b = bundle("json-schema", [{ path: "Account.json", content: '{"$ref":"Address.json"}' }, { path: "Address.json", content: '{"$ref":"Account.json"}' }]);
    expect(() => registryNodes(b, settings())).toThrow(/Cyclic/);
    expect(() => registryNodes(bundle("bigquery", [{ path: "Account.sql", content: "CREATE TABLE" }]), settings())).toThrow(/cannot be submitted/);
  });
  it("records the registry identity separately and uses exact dependency versions", async () => {
    const b = bundle("json-schema", [{ path: "Account.json", content: '{"$ref":"Address.json"}' }, { path: "Address.json", content: '{}' }]);
    const registered = new Map<string, { id: number; version: number }>();
    call.mockImplementation(async (url: string, method: string, _headers: unknown, body: unknown) => {
      const subject = decodeURIComponent(url.match(/subjects\/([^/]+)/)?.[1] ?? "");
      if (url.endsWith("/versions/latest")) return registered.get(subject) ?? null;
      if (url.includes("/compatibility/")) return { is_compatible: true };
      if (url.endsWith("/versions") && method === "POST") { registered.set(subject, { id: subject === "address-value" ? 100 : 200, version: subject === "address-value" ? 7 : 3 }); return { id: registered.get(subject)!.id }; }
      if (method === "POST") return registered.get(subject) ?? null;
      throw new Error("Unexpected registry call " + url + JSON.stringify(body));
    });
    const receipt = await new RegistryClient("https://registry.example", { authType: "none" }).deliver(b, settings());
    expect(receipt.registrations).toEqual([{ path: "Address.json", subject: "address-value", id: 100, version: 7 }, { path: "Account.json", subject: "account-value", id: 200, version: 3 }]);
    expect(call.mock.calls.find(([url]) => url === "https://registry.example/subjects/account-value/versions")?.[3]).toMatchObject({ references: [{ name: "Address.json", subject: "address-value", version: 7 }] });
  });
  it("reuses an existing registration and never changes compatibility policy", async () => {
    call.mockResolvedValue({ id: 22, version: 8 });
    const receipt = await new RegistryClient("https://registry.example", { authType: "none" }).deliver(bundle("avro", [{ path: "Account.avsc", content: '{"type":"record","name":"Account","fields":[]}' }]), settings());
    expect(receipt.registrations?.[0]).toMatchObject({ id: 22, version: 8 });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("blocks incompatible content before registration", async () => {
    call.mockImplementation(async (url: string) => url.includes("compatibility") ? { is_compatible: false } : { id: 1, version: 1 });
    await expect(new RegistryClient("https://registry.example", { authType: "none" }).preview(bundle("avro", [{ path: "Account.avsc", content: '{"type":"record","name":"Account","fields":[]}' }]), settings())).rejects.toThrow(/incompatible/);
  });
});
