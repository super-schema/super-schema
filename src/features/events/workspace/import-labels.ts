// src/features/events/workspace/import-labels.ts
// The user-facing wording of the AsyncAPI importer (the "Import existing…" link of the New Event dialog and the three-step import
// dialog), in one place: every label, hint, heading and sentence, so a change of wording is one edit. The groups:
//  - what each warning code and each error code is called (both are EXHAUSTIVE records: a code the importer gains does not compile until
//    it has wording here);
//  - the one product point the review step must say plainly: the payload entities are created as unpublished DRAFTS and the event's
//    messages pin them without a version, so before the event can publish, each entity must be published and its version picked;
//  - how the importer's own summary line ("N more warnings were omitted") is recognised, so it is shown as a note and not as a warning.
// Pure, client-safe: types only, nothing from the server.
import { OMITTED_WARNINGS_PATTERN } from "@/lib/events/import/bound";
import type { ImportErrorCode, ImportWarning, ImportWarningCode } from "@/lib/events/import/types";
import type { AsyncApiImportPreview } from "@/services/events/asyncapi-import.service";

type PlannedFormat = AsyncApiImportPreview["entities"][number]["format"];
type Counts = AsyncApiImportPreview["counts"];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ── The link in the New Event dialog ───────────────────────────────────────────────────────────────────────────────────

export const IMPORT_EXISTING_PROMPT = "Already have an AsyncAPI document?";
export const IMPORT_EXISTING_LABEL = "Import existing…";

// ── The dialog ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DIALOG_TITLE = "Import an AsyncAPI document";
export const DIALOG_DESCRIPTION = "Bring an AsyncAPI 3.0 document in as a new event. You see what it will create before anything is created.";

export type ImportStep = 1 | 2 | 3;
const STEP_NAMES: Record<ImportStep, string> = { 1: "Document", 2: "Review", 3: "Import" };
/** "Step 2 of 3: Review". */
export const stepIndicator = (step: ImportStep): string => `Step ${step} of 3: ${STEP_NAMES[step]}`;

export const BACK = "Back";
export const CANCEL = "Cancel";
export const CLOSE = "Close";
export const PREVIEW = "Preview";
export const CHECKING = "Checking…";
export const IMPORT = "Import";
export const IMPORTING = "Importing…";
export const TRY_AGAIN = "Try again";

// ── Step 1: the document ───────────────────────────────────────────────────────────────────────────────────────────────

export const DOCUMENT_LABEL = "AsyncAPI document";
export const DOCUMENT_PLACEHOLDER = "asyncapi: 3.0.0\ninfo:\n  title: Orders\n  version: 1.0.0\n…";
export const DOCUMENT_HINT = "Paste YAML or JSON. Only AsyncAPI 3.0 can be imported, up to 800 KB. References must point inside the document: nothing is fetched from a URL.";

export const UPLOAD_LABEL = "Upload file";
/** The `accept` of the file input: the types the importer reads. */
export const UPLOAD_ACCEPT = ".yaml,.yml,.json";
export const UPLOAD_HINT = "A .yaml, .yml or .json file. Its text fills the box above, where you can still edit it.";
/**
 * Largest document the dialog sends, in UTF-8 bytes. The server accepts 1 MiB, but a server action's request body is limited by Next
 * (about 1 MB by default, and the request escapes quotes and newlines), so a document near 1 MiB would be refused by the framework with
 * an error nobody can read. 800,000 bytes leaves room for the escaping; direct callers of the action still get the server's own cap.
 */
export const MAX_DOCUMENT_BYTES = 800_000;
/** Shown for a file or a pasted text over `MAX_DOCUMENT_BYTES`. */
export const DOCUMENT_TOO_LARGE = "The document is larger than 800 KB. Split it or remove unused components.";
export const FILE_UNREADABLE = "The file could not be read";
export const FILE_EMPTY = "The file is empty.";

// ── Step 2: the review ─────────────────────────────────────────────────────────────────────────────────────────────────

export const REVIEW_HEADING = "What the import will create";
export const EVENT_NAME_LABEL = "Event name";
export const EVENT_NAME_HINT = 'Letters, digits, ".", "_" and "-" (up to 128). A name that is already taken in this product gets a number added.';
export const EVENT_NAME_REQUIRED = "Name is required.";
/** "From the document “Streetlights Kafka API”". */
export const fromDocumentTitle = (title: string): string => `From the document “${title}”`;

/** What the counts are called; the order here is the order shown. */
export const COUNT_LABELS: Record<keyof Counts, string> = {
  servers: "Servers", channels: "Channels", messages: "Messages", operations: "Operations", traits: "Properties", securitySchemes: "Security schemes",
};

export const entitiesHeading = (n: number): string => `${plural(n, "entity", "entities")} to create`;
export const NO_ENTITIES = "No entities: the document has no message payloads.";
export const fieldCount = (n: number): string => plural(n, "field", "fields");
/** What an entity is made from; a placeholder has no fields and is described by hand afterwards. */
export const FORMAT_LABELS: Record<PlannedFormat, string> = {
  "json-schema": "JSON Schema", avro: "Avro", protobuf: "Protobuf", placeholder: "Placeholder",
};
export const RENAMED_BADGE = "Renamed";
/** Under a renamed entity: what the document asked for. */
export const renamedNote = (requested: string): string => `The document asks for "${requested}", but that name is taken in this product.`;
export const builtInTraitsText = (names: readonly string[]): string => `Built-in message properties used instead of copies: ${names.join(", ")}.`;

/**
 * The product point of the review: the entities are drafts and the event's messages pin them WITHOUT a version, so the event cannot
 * publish until each entity is published and its published version is pinned in the messages. Shown whenever an entity is created.
 */
export const DRAFTS_HEADING = "After the import";
export const DRAFTS_NOTE = "The imported entities are drafts. Publish them, then pin their published versions in the event's messages. An event cannot be published while a message points to an unpublished entity.";

// ── Warnings ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What each group of warnings says happened; the order here is the order the groups are shown in. */
export const IMPORT_WARNING_LABELS: Record<ImportWarningCode, string> = {
  UNSUPPORTED_PAYLOAD_FORMAT: "Payloads that could not be imported (an entity with no fields stands in)",
  NO_PAYLOAD: "Messages without a payload (an entity with no fields stands in)",
  UNSUPPORTED_EXTENSION: "Extensions (x-…) that were not imported",
  DROPPED_CONSTRUCT: "Parts of the document that were left out",
  ENTITY_RENAMED: "Names that were changed because they were taken",
  BUILTIN_TRAIT_MAPPED: "Message properties replaced by a built-in set",
  KEY_ADJUSTED: "Keys that were changed",
  SANITIZED_VALUE: "Values that were removed or corrected",
  VALIDATION_WARNING: "Findings of the AsyncAPI validator",
};
/** The group's heading; a code this build has no wording for (a newer server) is shown as it is. */
export const warningGroupLabel = (code: string): string => (Object.hasOwn(IMPORT_WARNING_LABELS, code) ? IMPORT_WARNING_LABELS[code as ImportWarningCode] : code);
export const warningCount = (n: number): string => plural(n, "warning", "warnings");
export const WARNINGS_HEADING = "Warnings";
export const WARNINGS_NOTE = "Warnings do not stop the import.";
/** Where in the SOURCE file a warning points; "" is the document itself. */
export const warningPointer = (pointer: string): string => (pointer === "" ? "the document" : pointer);
/** How many items of a group are listed before "Show all". */
export const WARNINGS_SHOWN_PER_GROUP = 20;
export const showAllWarnings = (n: number): string => `Show all ${n}`;

/**
 * The importer caps the warnings it reports and adds ONE last warning (code `DROPPED_CONSTRUCT`, pointer "") worded by
 * `omittedWarningsMessage` ("N more warning(s) was/were omitted", `src/lib/events/import/bound.ts`, which also owns the pattern). It is a
 * note about the list, not a dropped part of the document, so the review recognises it by that pattern and shows it under the list.
 */
export { OMITTED_WARNINGS_PATTERN };
/** N when `warning` is the importer's "N more warnings were omitted" summary line, otherwise null. */
export function omittedWarningsCount(warning: ImportWarning): number | null {
  if (warning.pointer !== "" || warning.code !== "DROPPED_CONSTRUCT") return null;
  const match = OMITTED_WARNINGS_PATTERN.exec(warning.message);
  return match ? Number(match[1]) : null;
}
export const omittedWarningsNote = (n: number): string => `${n} more ${n === 1 ? "warning was" : "warnings were"} omitted from this list.`;

// ── Problems (the document cannot be imported) ─────────────────────────────────────────────────────────────────────────

export const PROBLEMS_HEADING = "This document cannot be imported";
export const PROBLEMS_LEAD = "Nothing was created. Fix these problems in the document, then preview it again.";
/**
 * How many problems the server reports at most (`MAX_PARSER_PROBLEMS` in `src/services/events/import-limits.ts`; a test pins the two
 * equal). A list that long was cut off by the server, so its length is a lower bound, not a count.
 */
export const PROBLEMS_SHOWN_CAP = 100;
export const problemCount = (n: number): string => (n >= PROBLEMS_SHOWN_CAP ? `at least ${PROBLEMS_SHOWN_CAP} problems` : plural(n, "problem", "problems"));
/** How many problems are listed; the rest is a count. */
export const PROBLEMS_SHOWN = 50;
export const problemsMore = (n: number): string => `and ${n} more not shown`;

/** The first line of an error, by its code. Every importer error code has one; a code from elsewhere has none (its message stands alone). */
export const ERROR_HEADLINES: Record<ImportErrorCode, string> = {
  PARSE_ERROR: "The document could not be read",
  UNSUPPORTED_VERSION: "AsyncAPI 3.0 only",
  TOO_LARGE: "The document is too large",
  EXTERNAL_REF: "The document refers to another file or a URL",
  REF_CYCLE: "The document has a reference that leads back to itself",
  REF_NOT_FOUND: "A reference points at nothing",
  REF_TOO_LARGE: "The document expands into too much",
  MISSING_PAYLOAD_PIN: "A message has no payload entity",
  VALIDATION_ERROR: "The document cannot be imported",
  IMPORT_FAILED: "The import failed",
};
/** The first line of `IMPORT_FAILED` when it refuses a PREVIEW: a preview writes nothing, so it is not an import that failed. */
export const PREVIEW_FAILED_HEADING = "The document could not be processed";
export const errorHeadline = (code: string | null | undefined): string | null =>
  code !== null && code !== undefined && Object.hasOwn(ERROR_HEADLINES, code) ? ERROR_HEADLINES[code as keyof typeof ERROR_HEADLINES] : null;

// ── Step 3: the import ─────────────────────────────────────────────────────────────────────────────────────────────────

export const IMPORTING_HEADING = "Importing…";
export const IMPORTING_STATUS = "Creating the entities, then the event. Keep this window open.";
export const IMPORTED_HEADING = "Imported";
export const IMPORTED_STATUS = "Opening the event…";
/** Shown when opening the event takes too long (see `IMPORT_STALL_MS`): the import itself is done, only the page change hangs. */
export const IMPORT_STALLED = "This is taking longer than expected. The event was created; you can close this window and find it in the explorer on the left.";
export const FAILED_HEADING = "The import failed";
export const NOTHING_CREATED = "Nothing was created.";
/** Instead of "Nothing was created." when the connection failed: the server may have finished the import. */
export const OUTCOME_UNKNOWN = "The connection failed, so it is not known whether the import went through. Close this window and look for the event in the explorer on the left before you import again.";
export const LEFTOVERS_LEAD = "Some of what the import had created could not be removed again:";
export const LEFTOVERS_ACTION = "Delete them by hand in this product before you import again; their names are taken until you do.";
export const leftoverEntity = (name: string | null): string => (name === null ? "An entity" : `The entity "${name}"`);
export const leftoverEvent = (name: string): string => `The event "${name}"`;
/** The success toast. */
export const importedToast = (eventName: string, entities: number): string =>
  entities === 0 ? `Imported "${eventName}"` : `Imported "${eventName}" with ${plural(entities, "draft entity", "draft entities")}`;
