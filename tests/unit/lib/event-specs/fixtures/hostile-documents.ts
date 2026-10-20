/**
 * Documents that cost a synchronous parser seconds although they pass every size cap of the importer (measured before the parser ran in a
 * worker: `parameters` 9.4 - 13 s and 119,941 diagnostics; the YAML flood 6.3 s for `]` x 1 MiB).
 */
const base36 = (count: number): string[] => Array.from({ length: count }, (_, i) => i.toString(36));

/** 60 channels of 1,999 `parameters` entries each (each object is under the importer's 2,000-entry cap; the file is under 1 MiB). */
export function hostileParametersDocument(): { asyncapi: string; info: { title: string; version: string }; channels: Record<string, unknown> } {
  const channels: Record<string, unknown> = {};
  for (let c = 0; c < 60; c += 1) channels[`c${c}`] = { address: `c${c}`, parameters: Object.fromEntries(base36(1_999).map((key) => [key, {}])) };
  return { asyncapi: "3.0.0", info: { title: "Hostile", version: "1" }, channels };
}

/** The same document as the importer receives it: JSON text, just under 1 MiB. */
export const hostileParametersText = (): string => JSON.stringify(hostileParametersDocument());

/** A text of 1,000,000 `]`: about a million syntax errors for the `yaml` package (6.3 s of CPU before the read ran in a worker). */
export const yamlErrorFlood = (): string => "]".repeat(1_000_000);

/** A valid small document: validating it is quick and clean. */
export const smallDocument = (title = "Small"): object => ({
  asyncapi: "3.0.0",
  info: { title, version: "1.0.0" },
  channels: { events: { address: "events.v1", messages: { created: { payload: { type: "object", properties: { id: { type: "string" } } } } } } },
  operations: { sendEvents: { action: "send", channel: { $ref: "#/channels/events" }, messages: [{ $ref: "#/channels/events/messages/created" }] } },
});
