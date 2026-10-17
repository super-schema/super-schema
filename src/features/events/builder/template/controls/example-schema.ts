// src/features/events/builder/template/controls/example-schema.ts
// Which "json" fields are the example payload / headers of a MESSAGE, and the schema each is checked against. Pure, no React.
// The fields are recognised by their pointer (`/messages/{i}/examples/{n}/payload`), not by name: a trait's examples
// (`/traits/{i}/examples/{n}/payload`) have no payload entity to check against, and the binding fields that are also called
// `headers` (`.../bindings/http/headers`) are not examples.
import type { TemplateFormContext } from "./types";

/** What an example field is an example OF: the message's payload entity or its headers entity. */
export type ExampleSource = "payload" | "headers";

const MESSAGE_EXAMPLE_FIELD = /^\/messages\/\d+\/examples\/\d+\/(payload|headers)$/;

/** `payload` / `headers` for the example field at `path` of a message, else null. */
export function exampleSource(path: string): ExampleSource | null {
  const match = MESSAGE_EXAMPLE_FIELD.exec(path);
  return match === null ? null : (match[1] as ExampleSource);
}

/** The schema the example field at `path` is checked against, or null: not an example field, or no schema known (yet). */
export function exampleSchema(path: string, context: TemplateFormContext | undefined): Record<string, unknown> | null {
  const source = exampleSource(path);
  return source === null ? null : (context?.pinSchemas?.[source] ?? null);
}
