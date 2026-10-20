"use client";

// src/features/events/workspace/use-asyncapi-import.ts
// The state machine behind the import dialog: document → review → import. It owns the text, the review, the event name, the
// single-flight guard and the three actions (read a file, preview, import); the dialog only draws it.
//
//   input      the document is pasted or read from a file; Preview asks the server what an import would do (writes nothing).
//   preview    the review: the resolved event name (editable), counts, entities, warnings. A document the server refuses with a list of
//              problems is shown here too, as the list, with no way to import it. Any other refusal stays on `input`, next to the text.
//   importing  the import is running. `imported` is the success (the dialog stays locked: the host navigates to the event, and if that
//              takes `IMPORT_STALL_MS` the dialog unlocks and says so, `stalled`) and `failed` the failure (what the server did to undo it,
//              then Back or Try again; after a failure of unknown outcome only Back (to the document) and Close, and the tree is refreshed).
//
// Both server actions return an `ActionResult` and never throw; a rejected promise (network, serialization) is shown as the generic
// message. A second Preview or Import in the same tick is ignored (`inFlight`, a ref: the closure of a second click still sees the old state).
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { importAsyncApiAction, previewAsyncApiImportAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { normalizeCatalogName } from "@/lib/events/inputs";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { AsyncApiImportPreview } from "@/services/events/asyncapi-import.service";
import { actionErrorText, ENDS_A_SENTENCE, GENERIC_ACTION_ERROR } from "@/types/action-result";
import {
  DOCUMENT_TOO_LARGE, EVENT_NAME_REQUIRED, FILE_EMPTY, FILE_UNREADABLE, importedToast, MAX_DOCUMENT_BYTES, type ImportStep,
} from "./import-labels";

export type ImportStage = "input" | "preview" | "importing" | "imported" | "failed";

/** How long the dialog stays locked after a success while the host opens the event: past this the user can close it (the event exists). */
export const IMPORT_STALL_MS = 15_000;

/** One thing the AsyncAPI validator found wrong, `pointer` an RFC 6901 pointer into the document ("" = the document itself). */
export interface ImportProblem { pointer: string; message: string }
/** Something a failed import could not delete again. The event's name is the one the user chose, so only the entity's is carried. */
export interface ImportLeftover { kind: "entity" | "event"; name: string | null }

export interface ImportFailure {
  code: string | null;
  /** The service's message and remedy; the generic message for a database failure or a thrown action. */
  text: string;
  problems: ImportProblem[];
  leftovers: ImportLeftover[];
  /** The action never answered (a network failure): the server may have finished the import, so nothing may be claimed about what exists. */
  unknownOutcome?: true;
}

export type Review =
  | { kind: "preview"; preview: AsyncApiImportPreview }
  | { kind: "problems"; failure: ImportFailure };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function readProblems(details: unknown): ImportProblem[] {
  const list = isRecord(details) ? details.problems : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): ImportProblem[] => {
    if (!isRecord(entry) || typeof entry.message !== "string" || entry.message === "") return [];
    return [{ pointer: typeof entry.pointer === "string" ? entry.pointer : "", message: entry.message }];
  });
}

function readLeftovers(details: unknown): ImportLeftover[] {
  const list = isRecord(details) ? details.leftovers : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry): ImportLeftover[] => {
    if (!isRecord(entry) || (entry.kind !== "entity" && entry.kind !== "event")) return [];
    return [{ kind: entry.kind, name: typeof entry.name === "string" ? entry.name : null }];
  });
}

/** A failed action result as the dialog shows it. `details` is untrusted shape: only what is read here is used. */
export function failureOf(result: { error: string; code?: string; details?: object; suggestedFix?: string }): ImportFailure {
  return { code: result.code ?? null, text: actionErrorText(result), problems: readProblems(result.details), leftovers: readLeftovers(result.details) };
}

const plainFailure = (text: string): ImportFailure => ({ code: null, text, problems: [], leftovers: [] });

/** The service's refusal of a name, as sentences: "<message>. <fix>" (the shared join); a message with no fix ends in a full stop too. */
function nameErrorText(message: string, fix: string | undefined): string {
  if (fix) return actionErrorText({ error: message, suggestedFix: fix });
  return ENDS_A_SENTENCE.test(message.trimEnd()) ? message : `${message}.`;
}

/** Whether the text is over the dialog's limit, measured in UTF-8 bytes as the request carries it (a `.length` would undercount accented and CJK text). */
function overLimit(text: string): boolean {
  return new TextEncoder().encode(text).byteLength > MAX_DOCUMENT_BYTES;
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

export function useAsyncApiImport({ productId, onImported, onLockChange }: {
  productId: string;
  /** The new event's id, after the import succeeded (the host navigates to it). The dialog stays locked afterwards. */
  onImported: (eventId: string) => void;
  /** True from the moment the import starts until it fails; true for good after a success. The dialog cannot be dismissed meanwhile. */
  onLockChange: (locked: boolean) => void;
}) {
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [stage, setStage] = useState<ImportStage>("input");
  const [content, setContent] = useState("");
  /** The text the last uploaded file produced: while the box still holds exactly that, the file's name is sent along. */
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [inputFailure, setInputFailure] = useState<ImportFailure | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [eventName, setEventNameText] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [importFailure, setImportFailure] = useState<ImportFailure | null>(null);
  /** What the review was made from: Import sends exactly this, whatever the box holds by then. */
  const source = useRef<{ content: string; fileName?: string } | null>(null);
  const inFlight = useRef(false);

  const step: ImportStep = stage === "input" ? 1 : stage === "preview" ? 2 : 3;

  function editContent(text: string) {
    setContent(text);
    setInputFailure(null);
  }

  function setEventName(text: string) {
    setEventNameText(text);
    setNameError(null);
  }

  async function loadFile(picked: File) {
    if (picked.size > MAX_DOCUMENT_BYTES) {
      setInputFailure(plainFailure(DOCUMENT_TOO_LARGE));
      return;
    }
    try {
      const text = await readAsText(picked);
      // Nothing to import, or not text at all: a binary file decodes to U+FFFD (or NUL) characters, which re-encode to far more bytes than
      // the file had and would then be refused as "larger than 800 KB". Neither fills the box.
      if (text.trim() === "") {
        setInputFailure(plainFailure(FILE_EMPTY));
        return;
      }
      if (text.includes("\0") || text.includes("\u{FFFD}")) {
        setInputFailure(plainFailure(FILE_UNREADABLE));
        return;
      }
      setContent(text);
      setFile({ name: picked.name, text });
      setInputFailure(null);
    } catch (e: unknown) {
      console.error("[import-asyncapi] reading the file failed", e);
      setInputFailure(plainFailure(FILE_UNREADABLE));
    }
  }

  async function preview() {
    if (inFlight.current || content.trim() === "") return;
    if (overLimit(content)) {
      setInputFailure(plainFailure(DOCUMENT_TOO_LARGE));
      return;
    }
    inFlight.current = true;
    setPreviewing(true);
    setInputFailure(null);
    const fileName = file !== null && file.text === content ? file.name : undefined;
    try {
      const result = await previewAsyncApiImportAction(productId, { content, ...(fileName && { fileName }) });
      if (result.success) {
        source.current = { content, fileName };
        setReview({ kind: "preview", preview: result.data });
        setEventNameText(result.data.eventName);
        setNameError(null);
        setStage("preview");
        return;
      }
      const failure = failureOf(result);
      if (failure.problems.length > 0) {
        source.current = null;
        setReview({ kind: "problems", failure });
        setStage("preview");
      } else {
        setInputFailure(failure);
      }
    } catch (e: unknown) {
      console.error("[import-asyncapi] the preview action threw", e);
      setInputFailure(plainFailure(GENERIC_ACTION_ERROR));
    } finally {
      inFlight.current = false;
      setPreviewing(false);
    }
  }

  async function runImport() {
    if (inFlight.current || (stage !== "preview" && stage !== "failed")) return;
    // After a failure of unknown outcome the import may have landed: a second one could create the event twice (Back, and a new preview, is the way on).
    if (stage === "failed" && importFailure?.unknownOutcome === true) return;
    if (review?.kind !== "preview" || source.current === null) return;
    const trimmed = eventName.trim();
    if (trimmed === "") {
      setNameError(EVENT_NAME_REQUIRED);
      return;
    }
    // The service's own rule, so the user is told here, next to the field, and nothing is sent.
    const name = normalizeCatalogName(trimmed, "Event");
    if (!name.success) {
      setNameError(nameErrorText(name.error.message, name.error.suggestedFix));
      return;
    }
    inFlight.current = true;
    onLockChange(true);
    setImportFailure(null);
    setStage("importing");
    const { content: text, fileName } = source.current;
    let result: Awaited<ReturnType<typeof importAsyncApiAction>>;
    try {
      result = await importAsyncApiAction(productId, { content: text, ...(fileName && { fileName }), eventName: name.data });
    } catch (e: unknown) {
      console.error("[import-asyncapi] the import action threw", e);
      // A rejected action says nothing about what the server did, so the failure must not claim that nothing was created.
      setImportFailure({ ...plainFailure(GENERIC_ACTION_ERROR), unknownOutcome: true });
      setStage("failed");
      onLockChange(false);
      inFlight.current = false;
      // If the import did land, the explorer must show the event and its entities: the dialog sends the user to look there.
      void invalidateDomainsTree();
      return;
    }
    if (!result.success) {
      const failure = failureOf(result);
      setImportFailure(failure);
      setStage("failed");
      onLockChange(false);
      inFlight.current = false;
      // What could not be rolled back is in the product now and the user is told to delete it: the tree must show it.
      if (failure.leftovers.length > 0) void invalidateDomainsTree();
      return;
    }
    // Stays locked and in flight: the host navigates to the event, and a second import now would create a duplicate.
    toast.success(importedToast(result.data.preview.eventName, result.data.preview.entities.length));
    void invalidateDomainsTree();
    setStage("imported");
    onImported(result.data.eventId);
  }

  // After a success the host opens the event. If that has not happened `IMPORT_STALL_MS` later the user is let out: the dialog unlocks and
  // says the event exists. The timer goes when the dialog does (the wizard unmounts, which clears it).
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (stage !== "imported") return undefined;
    const timer = setTimeout(() => {
      setStalled(true);
      onLockChange(false);
    }, IMPORT_STALL_MS);
    return () => clearTimeout(timer);
  }, [stage, onLockChange]);

  /**
   * Back from the review to the document, or from a failure to the review. Not while something runs. After a failure of unknown outcome
   * it goes to the document instead: the name on the review may be taken by the import that did land, and only a new preview says so
   * (it then offers the numbered name).
   */
  function back() {
    if (inFlight.current) return;
    if (stage === "preview") {
      setNameError(null);
      setStage("input");
    } else if (stage === "failed") {
      const unknownOutcome = importFailure?.unknownOutcome === true;
      setImportFailure(null);
      setStage(unknownOutcome ? "input" : "preview");
    }
  }

  /** What Enter in the form does: the primary action of the current stage. */
  function submit() {
    if (stage === "input") void preview();
    else if (stage === "preview" || stage === "failed") void runImport();
  }

  return {
    stage, step, content, editContent, loadFile, inputFailure, previewing, review, eventName, setEventName, nameError, importFailure, back, submit, stalled,
    /** The preview is running or the import is: controls that start or change something are off. */
    working: previewing || stage === "importing" || stage === "imported",
  };
}
