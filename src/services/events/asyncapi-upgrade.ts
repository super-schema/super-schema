// src/services/events/asyncapi-upgrade.ts
// Step 0 of the AsyncAPI import: make a document the 3.0 importer can read out of one it cannot yet.
//  - AsyncAPI 2.x is converted to 3.0 (`@asyncapi/converter`); the importer itself only reads 3.x.
//  - Sibling files the caller provides (`files`) are folded into the document (`external-refs.ts`); an external `$ref` that cannot be loaded
//    degrades to a warning and an empty schema instead of failing the import.
// A 3.x document with no `files` is returned untouched (its external references keep failing as before, `EXTERNAL_REF`).
// Server only (the converter is not client-safe). Never throws.
import { convert } from "@asyncapi/converter";
import { parse as parseYaml } from "yaml";
import { err, ok, type Result } from "@/types/result";
import { MAX_ALIAS_COUNT } from "@/lib/events/import/limits";
import { inlineExternalRefs } from "@/lib/events/import/external-refs";
import type { ImportWarning } from "@/lib/events/import/types";

export interface UpgradedSource { text: string; warnings: ImportWarning[] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Cheap pre-check, so a document that needs no upgrade is never parsed here (the child-process reader parses it, with its hostile-input limits). */
const DECLARES_V2 = /^\s*\{?\s*["']?asyncapi["']?\s*:\s*["']?2\./m;
const hasExternalRef = (text: string): boolean => /"\$ref"\s*:\s*"(?!#)|\$ref\s*:\s*["']?(?!#)/.test(text);

/**
 * The converter gives every 2.x message the same key (`post.message`), which the importer must then make unique (`post.message-2`). A channel
 * with one message used by operations whose id reads `<name>.<verb>` gets `<name>` as the message key instead, and every reference follows.
 */
function nameMessagesAfterOperations(doc: Record<string, unknown>): Record<string, unknown> {
  const channels = doc.channels;
  const operations = doc.operations;
  if (!isObject(channels) || !isObject(operations)) return doc;
  const renames = new Map<string, string>(); // old pointer -> new pointer
  const taken = new Set<string>();
  const nextChannels: Record<string, unknown> = {};
  for (const [channelKey, channel] of Object.entries(channels)) {
    const messages = isObject(channel) && isObject(channel.messages) ? channel.messages : undefined;
    const keys = messages ? Object.keys(messages) : [];
    if (!isObject(channel) || !messages || keys.length !== 1) { nextChannels[channelKey] = channel; continue; }
    const operationIds = Object.entries(operations)
      .filter(([, op]) => isObject(op) && isObject(op.channel) && op.channel.$ref === `#/channels/${channelKey}`)
      .map(([id]) => id.replace(/\.(post|publish|subscribe|send|receive)$/i, ""));
    const wanted = operationIds.length === 1 && /^[A-Za-z0-9._-]+$/.test(operationIds[0]) ? operationIds[0] : undefined;
    if (!wanted || wanted === keys[0] || taken.has(wanted)) { nextChannels[channelKey] = channel; continue; }
    taken.add(wanted);
    renames.set(`#/channels/${channelKey}/messages/${keys[0]}`, `#/channels/${channelKey}/messages/${wanted}`);
    nextChannels[channelKey] = { ...channel, messages: { [wanted]: messages[keys[0]] } };
  }
  if (renames.size === 0) return doc;
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === "$ref" && typeof v === "string" ? (renames.get(v) ?? v) : rewrite(v);
    return out;
  };
  return { ...doc, channels: nextChannels, operations: rewrite(operations) as Record<string, unknown> };
}

export function upgradeAsyncApiSource(text: string, files?: Readonly<Record<string, string>>): Result<UpgradedSource> {
  const hasFiles = files !== undefined && Object.keys(files).length > 0;
  const isV2 = DECLARES_V2.test(text);
  if (!isV2 && !hasFiles) return ok({ text, warnings: [] });
  if (!isV2 && !hasExternalRef(text)) return ok({ text, warnings: [] });

  let document: unknown;
  try {
    document = parseYaml(text, { maxAliasCount: MAX_ALIAS_COUNT, uniqueKeys: false });
  } catch {
    // not readable here: the strict reader reports the real problem, with its own message
    return ok({ text, warnings: [] });
  }
  if (!isObject(document)) return ok({ text, warnings: [] });

  const warnings: ImportWarning[] = [];
  let current: Record<string, unknown> = document;

  // Fold the sibling files in while the document is still the shape the author wrote (2.x refs sit under `message.payload` / `headers`).
  const folded = inlineExternalRefs(current, files ?? {}, (t) => parseYaml(t, { maxAliasCount: MAX_ALIAS_COUNT, uniqueKeys: false }));
  current = folded.document;
  warnings.push(...folded.warnings);

  if (isV2) {
    try {
      const converted = convert(JSON.stringify(current), "3.0.0", {});
      current = (typeof converted === "string" ? JSON.parse(converted) : converted) as Record<string, unknown>;
    } catch (e) {
      console.error("[asyncapi-upgrade] 2.x conversion failed", e);
      return err({
        code: "UNSUPPORTED_VERSION",
        message: "This AsyncAPI 2.x document could not be converted to AsyncAPI 3.0 automatically.",
        suggestedFix: "Convert it with the AsyncAPI CLI (asyncapi convert --target-version 3.0.0) and import the result.",
      });
    }
    current = nameMessagesAfterOperations(current);
    warnings.unshift({
      pointer: "", code: "SANITIZED_VALUE",
      message: "The document is AsyncAPI 2.x; it was converted to 3.0 for the import (a 2.x `publish` operation becomes a `receive` operation, `subscribe` becomes `send`). Check the operations' direction.",
    });
  }
  return ok({ text: JSON.stringify(current), warnings });
}
