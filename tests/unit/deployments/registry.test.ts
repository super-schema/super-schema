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
  describe("Protobuf with the generated metadata options file", () => {
    const options = { path: "superschema/metadata_options.proto", content: 'syntax = "proto3";\npackage superschema.metadata;\nimport "google/protobuf/descriptor.proto";\n' };
    const account = {
      path: "identity/accounts/account.proto",
      content: 'syntax = "proto3";\npackage identity.accounts;\nimport "superschema/metadata_options.proto";\nmessage Account {\n  string email = 1 [(.superschema.metadata.x_owner) = "a"];\n}\n',
    };
    /** A protobuf bundle as emission writes it: the options file belongs to no entity. */
    const protoBundle = (files: { path: string; content: string; entityId?: string }[]) =>
      freezeArtifact(entity, "protobuf", { version: 2, status: "published", output: "unused", entityVersion: 1, generatedAt: "now", primaryFile: files[0].path, files: files.map((f) => ({ ...f, target: "protobuf" as const })) });

    it("resolves the import from the bundle root and gives the options file its own subject, <subject>-metadata-options", () => {
      const nodes = registryNodes(protoBundle([{ ...account, entityId: "root" }, options]), WorkflowSettingsSchema.parse({ subject: "account-value" }));
      expect(nodes.map((n) => [n.path, n.subject])).toEqual([
        ["superschema/metadata_options.proto", "account-value-metadata-options"],
        ["identity/accounts/account.proto", "account-value"],
      ]);
      expect(nodes[1].dependencies).toEqual([{ name: "superschema/metadata_options.proto", path: "superschema/metadata_options.proto" }]);
      expect(nodes[0].dependencies).toEqual([]);
    });

    it("deploys two subjects, the entity referencing the options subject at its exact version", async () => {
      const registered = new Map<string, { id: number; version: number }>();
      call.mockImplementation(async (url: string, method: string) => {
        const subject = decodeURIComponent(url.match(/subjects\/([^/]+)/)?.[1] ?? "");
        if (url.endsWith("/versions/latest")) return registered.get(subject) ?? null;
        if (url.includes("/compatibility/")) return { is_compatible: true };
        if (url.endsWith("/versions") && method === "POST") { registered.set(subject, subject.endsWith("-metadata-options") ? { id: 10, version: 4 } : { id: 20, version: 1 }); return { id: 1 }; }
        if (method === "POST") return registered.get(subject) ?? null;
        throw new Error("Unexpected registry call " + url);
      });
      const receipt = await new RegistryClient("https://registry.example", { authType: "none" }).deliver(protoBundle([{ ...account, entityId: "root" }, options]), WorkflowSettingsSchema.parse({ subject: "account-value" }));
      expect(receipt.registrations).toEqual([
        { path: "superschema/metadata_options.proto", subject: "account-value-metadata-options", id: 10, version: 4 },
        { path: "identity/accounts/account.proto", subject: "account-value", id: 20, version: 1 },
      ]);
      const request = call.mock.calls.find(([url]) => url === "https://registry.example/subjects/account-value/versions")?.[3];
      expect(request).toMatchObject({ schemaType: "PROTOBUF", references: [{ name: "superschema/metadata_options.proto", subject: "account-value-metadata-options", version: 4 }] });
    });

    it("an existing protobuf bundle without options is unchanged: one subject, and a folder-relative import still resolves", () => {
      const plain = { path: "identity/accounts/account.proto", content: 'syntax = "proto3";\npackage identity.accounts;\nimport "google/protobuf/timestamp.proto";\nmessage Account {\n  string email = 1;\n}\n' };
      const nodes = registryNodes(protoBundle([{ ...plain, entityId: "root" }]), WorkflowSettingsSchema.parse({ subject: "account-value" }));
      expect(nodes).toEqual([{ path: plain.path, subject: "account-value", schema: plain.content, schemaType: "PROTOBUF", dependencies: [] }]);
      const relative = { path: "identity/accounts/account.proto", content: 'syntax = "proto3";\nimport "address.proto";\nmessage Account {}\n' };
      const address = { path: "identity/accounts/address.proto", content: 'syntax = "proto3";\nmessage Address {}\n' };
      const both = registryNodes(protoBundle([{ ...relative, entityId: "root" }, { ...address, entityId: "address" }]), WorkflowSettingsSchema.parse({ subject: "account-value", referenceSubjects: { "identity/accounts/address.proto": "address-value" } }));
      expect(both.map((n) => [n.path, n.subject])).toEqual([["identity/accounts/address.proto", "address-value"], ["identity/accounts/account.proto", "account-value"]]);
      expect(both[1].dependencies).toEqual([{ name: "address.proto", path: "identity/accounts/address.proto" }]);
    });
  });
});
