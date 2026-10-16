// src/lib/events/templates/keys.ts
// Generated identifiers (round-2 plan R3): the user types a title, host, address or name, never a key. Pure — client-safe.
import { slugKey, uniqueKey, type KeyKind } from "../document/keys";

export type { KeyKind };

/** What a key falls back to when nothing usable was typed (an external reference always starts from this). */
const FALLBACK: Record<KeyKind, string> = {
  server: "server", channel: "channel", message: "message", operation: "operation", trait: "trait", externalRef: "reference",
};

/** Text worth slugging: a string with at least one ASCII letter or digit (`slugKey` would turn the rest into "item"). */
const usable = (value: unknown): string | null => (typeof value === "string" && /[a-zA-Z0-9]/.test(value) ? value.trim() : null);

/** The candidate source texts for a key, best first. */
function candidates(kind: KeyKind, values: Record<string, unknown>): Array<string | null> {
  switch (kind) {
    case "server": return [usable(values.title), usable(values.host), usable(values.protocol)];
    case "channel": return [usable(values.title), usable(values.address)];
    case "message": return [usable(values.name), usable(values.title)];
    case "operation": {
      const action = usable(values.action);
      const channel = usable(values.channel);
      return [usable(values.title), action && channel ? `${action}-${channel}` : null];
    }
    case "trait": return [usable(values.name), usable(values.title)];
    case "externalRef": return [];
  }
}

/**
 * A readable, valid, unique key for a new part, from what the user already typed:
 * server title, host, protocol; channel title, address; message name, title; operation title, `${action}-${channel}`;
 * trait name, title; external reference `reference`; otherwise the kind itself.
 * The result matches `KEY_PATTERN`, is at most 64 characters, is never a reserved name and is not in `taken`
 * (`-2`, `-3`, … are appended), so two servers with the same host get distinct keys.
 */
export function suggestKey(kind: KeyKind, values: Record<string, unknown>, taken: Iterable<string>): string {
  const text = candidates(kind, values).find((candidate) => candidate !== null);
  return uniqueKey(text ? slugKey(text) : FALLBACK[kind], taken);
}
