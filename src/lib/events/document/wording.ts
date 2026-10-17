// src/lib/events/document/wording.ts
// What the user calls a trait, for the problem texts the document layer produces (parser, resolver, key rename) and the save
// validation. AsyncAPI says "trait"; the builder says "Message properties" / "Operation properties", so a problem text never says
// "trait". The UI's words live in `features/events/builder/labels.ts`, which `src/lib` does not import: they are repeated here, and
// tests/unit/lib/events/document/parse-wording.test.ts fails if they drift. Pure — client-safe.
import type { TraitKind } from "@/lib/event-specs/types";

/** "message properties" / "operation properties" (`labels.ts`: `propertiesNameLower`). */
export const propertiesNoun = (kind: TraitKind): string => `${kind.toLowerCase()} properties`;

/** For a key that may belong to either kind (one key space for both). */
export const ANY_PROPERTIES = "message or operation properties";

/** One whole set, where the sentence needs a singular subject: "set of message properties". */
export const propertiesSet = (kind: TraitKind): string => `set of ${propertiesNoun(kind)}`;
