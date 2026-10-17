// src/lib/events/import/sanitize.ts
// Reads values of an imported AsyncAPI file with the event document's OWN readers (`createObjectReaders`), so what the importer keeps is by
// construction what `parseEventDocument` accepts: an unknown property, a value of the wrong type or a blank required field is removed and
// reported (`SANITIZED_VALUE`), never copied through. Pure — client-safe.
import { createObjectReaders, type Reader } from "@/lib/events/document/parse-objects";
import type { ImportWarning } from "./types";

type Problem = { pointer: string; message: string };

export interface Sanitizer {
  /** The document's readers (`str`, `url`, `tags`, `externalDocs`, `correlationId`, `securityScheme`, `traitSpec`, …). */
  ax: ReturnType<typeof createObjectReaders>;
  /**
   * `reader(value, at)` with every complaint reported as a warning. The result is something the document accepts as is: when removing the
   * offending parts is not enough (a required field is missing), the WHOLE value is dropped and `undefined` is returned.
   */
  read<T>(reader: Reader<T>, value: unknown, at: string): T | undefined;
  /** Like `read` for an array whose entries are read one by one: a bad entry is dropped, the others stay; an empty result is `undefined`. */
  readEach<T>(reader: Reader<T>, value: unknown, at: string): T[] | undefined;
}

export function createSanitizer(warn: (warning: ImportWarning) => void): Sanitizer {
  // The readers report through one `bad` callback fixed at creation; `sink` is where it currently points.
  let sink: ((problem: Problem) => void) | null = null;
  const ax = createObjectReaders((pointer, message) => sink?.({ pointer, message }));

  function read<T>(reader: Reader<T>, value: unknown, at: string): T | undefined {
    if (value === undefined || value === null) return undefined;
    const found: Problem[] = [];
    sink = (problem) => found.push(problem);
    let out: T | undefined;
    try {
      out = reader(value, at);
    } finally {
      sink = null;
    }
    if (found.length === 0) return out;

    // The reader removed what it complained about. Is what is left accepted as is? If not (a required field is gone), drop it all.
    let remaining = 0;
    if (out !== undefined) {
      sink = () => { remaining += 1; };
      try {
        reader(out, at);
      } finally {
        sink = null;
      }
    }
    const dropped = out === undefined || remaining > 0;
    for (const problem of found) {
      warn({ pointer: problem.pointer, code: "SANITIZED_VALUE", message: `${problem.message}; ${dropped ? "the whole value was left out of the import" : "it was left out of the import"}` });
    }
    return dropped ? undefined : out;
  }

  function readEach<T>(reader: Reader<T>, value: unknown, at: string): T[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
      warn({ pointer: at, code: "SANITIZED_VALUE", message: `${at.slice(at.lastIndexOf("/") + 1)} must be a list; it was left out of the import` });
      return undefined;
    }
    const out: T[] = [];
    value.forEach((entry, i) => {
      const read1 = read(reader, entry, `${at}/${i}`);
      if (read1 !== undefined) out.push(read1);
    });
    return out.length > 0 ? out : undefined;
  }

  return { ax, read, readEach };
}
