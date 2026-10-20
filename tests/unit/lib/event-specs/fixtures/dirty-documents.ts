import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The documents the parser-isolation golden test (`parser-isolation.test.ts`) validates: every ordinary fixture of the importer (the ones
 * that are not `negative-*`) as it is, and each with ONE deliberate defect, so the golden diagnostics hold real errors and warnings and not only
 * the parser's advice about the latest version. The golden file was captured from the code BEFORE the parser ran in a worker.
 */
const FIXTURES = path.join(process.cwd(), "tests", "fixtures", "asyncapi-import");
const GOLDEN_DIR = path.join(process.cwd(), "tests", "unit", "lib", "event-specs", "__golden__");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- documents are mutated by path
const AVRO = "application/vnd.apache.avro+json;version=1.9.0";

/** One defect each. Every function mutates a copy and may assume nothing about the fixture (it adds what it needs). */
export const DEFECTS: Record<string, (doc: Doc) => void> = {
  "no-title": (doc) => { delete doc.info?.title; },
  "dangling-channel-ref": (doc) => {
    const first = Object.values(doc.operations ?? {})[0] as Doc | undefined;
    if (first) first.channel = { $ref: "#/channels/does-not-exist" };
    else doc.operations = { broken: { action: "send", channel: { $ref: "#/channels/does-not-exist" } } };
  },
  "server-without-host": (doc) => { (doc.servers ??= {}).broken = { protocol: "kafka" }; },
  "bad-avro-payload": (doc) => {
    ((doc.components ??= {}).messages ??= {}).zzAvro = { payload: { schemaFormat: AVRO, schema: { type: "record", name: "zz" } } };
  },
  "kafka-key-and-2020-12": (doc) => {
    const messages = ((doc.components ??= {}).messages ??= {});
    messages.zzKey = { payload: { type: "object" }, bindings: { kafka: { key: { schemaFormat: AVRO, schema: { type: "nope" } } } } };
    messages.zzNew = { payload: { schemaFormat: "application/schema+json;version=2020-12", schema: { type: "object" } } };
    messages.zzOther = { payload: { type: "object" }, bindings: { kafka: { key: { schemaFormat: "application/x-unknown", schema: {} } } } };
  },
};

export interface GoldenCase { name: string; document: object }

/** `fixtures/<file>` and `fixtures/<file>#<defect>` for every ordinary fixture, then the two emitted documents of the assembler's golden set. */
export function goldenCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const file of readdirSync(FIXTURES).filter((name) => !name.startsWith("negative-")).sort()) {
    const text = readFileSync(path.join(FIXTURES, file), "utf8");
    const read = (): Doc => (file.endsWith(".json") ? JSON.parse(text) : parseYaml(text)) as Doc;
    cases.push({ name: `fixtures/${file}`, document: read() });
    for (const [defect, apply] of Object.entries(DEFECTS)) {
      const document = read();
      apply(document);
      cases.push({ name: `fixtures/${file}#${defect}`, document });
    }
  }
  for (const file of ["checkout-service.asyncapi.json", "fraud-scorer.asyncapi.json"]) {
    cases.push({ name: `__golden__/${file}`, document: JSON.parse(readFileSync(path.join(GOLDEN_DIR, file), "utf8")) as object });
  }
  return cases;
}
