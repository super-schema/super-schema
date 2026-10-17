"use client";

// src/features/events/workspace/use-asyncapi-import.ts
// The state machine behind the import dialog: document → review → import. It owns the text, the review, the event name, the
// single-flight guard and the three actions (read a file, preview, import); the dialog only draws it.
//
//   input      the document is pasted or read from a file; Preview asks the server what an import would do (writes nothing).
//   preview    the review: the resolved event name (editable), counts, entities, warnings. A document the server refuses with a list of
//              problems is shown here too, as the list, with no way to import it. Any other refusal stays on `input`, next to the text.
//   importing  the import is running. `imported` is the success (the dialog stays locked: the host navigates to the event) and `failed`
//              the failure (what the server did to undo it, then Back or Try again).
//
// Both server actions return an `ActionResult` and never throw; a rejected promise (network, serialization) is shown as the generic
// message. A second Preview or Import in the same tick is ignored (`inFlight`, a ref: the closure of a second click still sees the old state).
import { useRef, useState } from "react";
import { toast } from "sonner";
import { importAsyncApiAction, previewAsyncApiImportAction } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions";
import { normalizeCatalogName } from "@/lib/events/inputs";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import type { AsyncApiImportPreview } from "@/services/events/asyncapi-import.service";
import { actionErrorText, GENERIC_ACTION_ERROR } from "@/types/action-result";
import { DOCUMENT_TOO_LARGE, EVENT_NAME_REQUIRED, FILE_UNREADABLE, importedToast, MAX_DOCUMENT_BYTES, type ImportStep } from "./import-labels";

export type ImportStage = "input" | "preview" | "importing" | "imported" | "failed";

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
    if (review?.kind !== "preview" || source.current === null) return;
    const trimmed = eventName.trim();
    if (trimmed === "") {
      setNameError(EVENT_NAME_REQUIRED);
      return;
    }
    // The service's own rule, so the user is told here, next to the field, and nothing is sent.
    const name = normalizeCatalogName(trimmed, "Event");
    if (!name.success) {
      setNameError([name.error.message, name.error.suggestedFix].filter(Boolean).join(" "));
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
      return;
    }
    if (!result.success) {
      setImportFailure(failureOf(result));
      setStage("failed");
      onLockChange(false);
      inFlight.current = false;
      return;
    }
    // Stays locked and in flight: the host navigates to the event, and a second import now would create a duplicate.
    toast.success(importedToast(result.data.preview.eventName, result.data.preview.entities.length));
    void invalidateDomainsTree();
    setStage("imported");
    onImported(result.data.eventId);
  }

  /** Back from the review to the document, or from a failure to the review. Not while something runs. */
  function back() {
    if (inFlight.current) return;
    if (stage === "preview") {
      setNameError(null);
      setStage("input");
    } else if (stage === "failed") {
      setImportFailure(null);
      setStage("preview");
    }
  }

  /** What Enter in the form does: the primary action of the current stage. */
  function submit() {
    if (stage === "input") void preview();
    else if (stage === "preview" || stage === "failed") void runImport();
  }

  return {
    stage, step, content, editContent, loadFile, inputFailure, previewing, review, eventName, setEventName, nameError, importFailure, back, submit,
    /** The preview is running or the import is: controls that start or change something are off. */
    working: previewing || stage === "importing" || stage === "imported",
  };
}
