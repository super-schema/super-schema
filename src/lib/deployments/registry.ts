import path from "node:path";
import { DeliveryError, type ArtifactBundle, type Credentials, type DeliveryReceipt, type WorkflowSettings } from "./contracts";
import { authHeaders, externalJson } from "./http";

interface Registration { id: number; version: number; subject?: string; }
export interface RegistryNode { path: string; subject: string; schema: string; schemaType: string; dependencies: { name: string; path: string }[]; }
const PRIMITIVES = new Set(["null", "boolean", "int", "long", "float", "double", "bytes", "string", "record", "enum", "array", "map", "fixed", "error"]);

function avroNames(value: unknown, namespace = "", definitions = new Set<string>(), uses = new Set<string>()): { definitions: Set<string>; uses: Set<string> } {
  if (typeof value === "string") { if (!PRIMITIVES.has(value)) uses.add(value.includes(".") || !namespace ? value : `${namespace}.${value}`); }
  else if (Array.isArray(value)) value.forEach((v) => avroNames(v, namespace, definitions, uses));
  else if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    let ns = typeof v.namespace === "string" ? v.namespace : namespace;
    if (["record", "enum", "fixed", "error"].includes(String(v.type)) && typeof v.name === "string") {
      const full = v.name.includes(".") || !ns ? v.name : `${ns}.${v.name}`;
      definitions.add(full); ns = full.includes(".") ? full.slice(0, full.lastIndexOf(".")) : "";
    }
    if (typeof v.type === "object" || typeof v.type === "string") avroNames(v.type, ns, definitions, uses);
    if (Array.isArray(v.fields)) v.fields.forEach((f) => { if (f && typeof f === "object") avroNames((f as Record<string, unknown>).type, ns, definitions, uses); });
    if (v.items) avroNames(v.items, ns, definitions, uses);
    if (v.values) avroNames(v.values, ns, definitions, uses);
  }
  return { definitions, uses };
}

export function registryNodes(bundle: ArtifactBundle, settings: WorkflowSettings): RegistryNode[] {
  const schemaType = ({ avro: "AVRO", "json-schema": "JSON", protobuf: "PROTOBUF" } as Record<string, string>)[bundle.format];
  if (!schemaType) throw new DeliveryError("This format cannot be submitted to Schema Registry");
  if (!settings.subject.trim()) throw new DeliveryError("A registry subject is required");
  const parsed = new Map<string, unknown>();
  if (schemaType !== "PROTOBUF") for (const file of bundle.files) {
    try { parsed.set(file.path, JSON.parse(file.content)); } catch { throw new DeliveryError(`The schema in ${file.path} is invalid JSON`); }
  }
  const avro = new Map([...parsed].map(([key, value]) => [key, avroNames(value)]));
  const nodes = bundle.files.map((file): RegistryNode => {
    const subject = file.path === bundle.primaryFile ? settings.subject.trim() : settings.referenceSubjects[file.path];
    const dependencies: RegistryNode["dependencies"] = [];
    const add = (name: string, target: string) => { if (target !== file.path && !dependencies.some((d) => d.name === name)) dependencies.push({ name, path: target }); };
    const resolve = (ref: string) => {
      const plain = ref.split("#")[0];
      if (!plain) return;
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), plain));
      const target = bundle.files.find((f) => f.path === relative || (parsed.get(f.path) as Record<string, unknown> | undefined)?.$id === plain);
      if (!target) throw new DeliveryError(`Referenced schema ${plain} is missing from the frozen artifact`);
      add(plain, target.path);
    };
    if (schemaType === "JSON") {
      const walk = (v: unknown) => {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) { v.forEach(walk); return; }
        for (const [k, entry] of Object.entries(v)) { if (k === "$ref" && typeof entry === "string") resolve(entry); else walk(entry); }
      }; walk(parsed.get(file.path));
    } else if (schemaType === "PROTOBUF") {
      for (const match of file.content.matchAll(/\bimport\s+(?:(?:public|weak)\s+)?"([^"\r\n]+)"\s*;/g)) if (!match[1].startsWith("google/protobuf/")) resolve(match[1]);
    } else {
      const info = avro.get(file.path)!;
      for (const name of info.uses) if (!info.definitions.has(name)) {
        const target = [...avro].find(([, entry]) => entry.definitions.has(name));
        if (!target) throw new DeliveryError(`Avro reference ${name} is missing from the frozen artifact`);
        add(name, target[0]);
      }
    }
    return { path: file.path, subject: subject ?? "", schema: file.content, schemaType, dependencies };
  });
  const ordered: RegistryNode[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (node: RegistryNode) => {
    if (visiting.has(node.path)) throw new DeliveryError("Cyclic registry references cannot be registered separately; generate a self-contained schema");
    if (visited.has(node.path)) return;
    if (!node.subject) throw new DeliveryError(`Configure a registry subject for dependency ${node.path}`);
    visiting.add(node.path);
    node.dependencies.forEach((d) => visit(nodes.find((n) => n.path === d.path)!));
    visiting.delete(node.path); visited.add(node.path); ordered.push(node);
  };
  visit(nodes.find((n) => n.path === bundle.primaryFile)!);
  if (new Set(ordered.map((n) => n.subject)).size !== ordered.length) throw new DeliveryError("Each referenced schema file needs a distinct registry subject");
  return ordered;
}

export class RegistryClient {
  private readonly url: string;
  constructor(url: string, private readonly credentials: Credentials) { this.url = url.replace(/\/$/, ""); }
  private call<T>(suffix: string, method: "GET" | "POST", body?: unknown, allow404 = false) {
    return externalJson<T>(`${this.url}${suffix}`, method, { ...authHeaders(this.credentials), Accept: "application/vnd.schemaregistry.v1+json" }, body, allow404);
  }
  async verify(): Promise<void> { await this.call("/subjects", "GET"); }
  async compatibility(node: RegistryNode, references: { name: string; subject: string; version: number }[]): Promise<void> {
    const subject = encodeURIComponent(node.subject);
    const exists = await this.call(`/subjects/${subject}/versions/latest`, "GET", undefined, true);
    if (!exists) return;
    const verdict = await this.call<{ is_compatible: boolean }>(`/compatibility/subjects/${subject}/versions?verbose=true`, "POST", { schemaType: node.schemaType, schema: node.schema, references });
    if (verdict?.is_compatible !== true) throw new DeliveryError(`The schema is incompatible with registry subject ${node.subject}`);
  }
  async preview(bundle: ArtifactBundle, settings: WorkflowSettings): Promise<string[]> {
    const nodes = registryNodes(bundle, settings);
    for (const node of nodes) if (!node.dependencies.length) await this.compatibility(node, []);
    return ["Schema files and reference order validated", ...(nodes.some((n) => n.dependencies.length) ? ["Dependent subjects are checked again before registration using exact dependency versions"] : ["Destination compatibility checked where the subject exists"])];
  }
  async deliver(bundle: ArtifactBundle, settings: WorkflowSettings): Promise<DeliveryReceipt> {
    const registrations: NonNullable<DeliveryReceipt["registrations"]> = [];
    for (const node of registryNodes(bundle, settings)) {
      const references = node.dependencies.map((d) => { const result = registrations.find((r) => r.path === d.path)!; return { name: d.name, subject: result.subject, version: result.version }; });
      const request = { schemaType: node.schemaType, schema: node.schema, references };
      const subject = encodeURIComponent(node.subject);
      let registered = await this.call<Registration>(`/subjects/${subject}`, "POST", request, true);
      if (!registered) {
        await this.compatibility(node, references);
        await this.call(`/subjects/${subject}/versions`, "POST", request);
        registered = await this.call<Registration>(`/subjects/${subject}`, "POST", request);
      }
      if (!registered || !Number.isInteger(registered.id) || !Number.isInteger(registered.version)) throw new DeliveryError("Registry did not return a verifiable schema identity", true, true);
      registrations.push({ path: node.path, subject: node.subject, id: registered.id, version: registered.version });
    }
    return { outcome: "registered", registrations };
  }
}
