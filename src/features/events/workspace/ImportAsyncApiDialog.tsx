"use client";

// src/features/events/workspace/ImportAsyncApiDialog.tsx
// The AsyncAPI importer's dialog, opened from the New Event dialog's "Import existing…" link. Three steps in one dialog:
//   1. Document   paste the text or upload a .yaml / .yml / .json file (the file only fills the box); Preview asks the server what an
//                 import would do and writes nothing.
//   2. Review     the event name (editable), counts, the entities with their final names, the built-in properties used, the warnings, and
//                 the sentence that matters most: the entities are created as DRAFTS. A document the validator refuses shows its problems
//                 here instead, with nothing to import.
//   3. Import     single-flight; success opens the event (`onImported`), failure says what the server did (it undoes what it created)
//                 and offers Back or Try again. When the connection failed nobody knows whether the import landed, so there is no
//                 Try again: Back (to the document, to preview again) and Close. If opening the event takes too long after a success,
//                 the dialog says the event exists and can be closed.
// Focus goes to the first control of each step, Escape closes the dialog unless the import is running, and the dialog cannot be
// dismissed at all while it runs (a failure must never land on a closed dialog). The wizard is its own component inside the dialog
// content, so every opening starts empty (the content is unmounted while closed).
import { useEffect, useRef, useState, type Ref } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/features/events/builder/controls";
import { FailurePanel, InputFailureAlert, ProblemsPanel, ReviewPanel } from "./ImportReview";
import {
  BACK, CANCEL, CHECKING, CLOSE, DIALOG_DESCRIPTION, DIALOG_TITLE, DOCUMENT_HINT, DOCUMENT_LABEL, DOCUMENT_PLACEHOLDER, IMPORT, IMPORT_STALLED,
  IMPORTED_HEADING, IMPORTED_STATUS, IMPORTING, IMPORTING_HEADING, IMPORTING_STATUS, PREVIEW, stepIndicator, TRY_AGAIN, UPLOAD_ACCEPT, UPLOAD_HINT,
  UPLOAD_LABEL,
} from "./import-labels";
import { useAsyncApiImport, type ImportFailure } from "./use-asyncapi-import";

export function ImportAsyncApiDialog({ productId, open, onOpenChange, onImported }: {
  productId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The new event's id. The dialog stays locked afterwards: the caller navigates to the event. */
  onImported: (eventId: string) => void;
}) {
  // While the import runs (and after it worked) nothing can dismiss the dialog: Escape, a click outside, the X.
  const [locked, setLocked] = useState(false);
  return (
    <Dialog
      open={open}
      disablePointerDismissal={locked}
      onOpenChange={(next) => {
        if (!next && locked) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl" showCloseButton={!locked} data-testid="import-asyncapi-dialog">
        <ImportWizard productId={productId} onImported={onImported} onLockChange={setLocked} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ImportWizard({ productId, onImported, onLockChange, onCancel }: {
  productId: string;
  onImported: (eventId: string) => void;
  onLockChange: (locked: boolean) => void;
  onCancel: () => void;
}) {
  const flow = useAsyncApiImport({ productId, onImported, onLockChange });
  const { stage, review } = flow;
  // A wizard that goes away (the dialog closed) must not leave the host's dialog locked.
  useEffect(() => () => onLockChange(false), [onLockChange]);

  // Focus: the first control of each step. While the import runs there is none, so the progress note takes it (the Import button that
  // had it is gone); a failure and the problems list put it on Back.
  const documentRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const showingProblems = stage === "preview" && review?.kind === "problems";
  const focusKey = showingProblems ? "problems" : stage;
  useEffect(() => {
    const targets = { input: documentRef, preview: nameRef, problems: backRef, failed: backRef, importing: progressRef, imported: progressRef };
    targets[focusKey].current?.focus();
  }, [focusKey]);
  // A refused name sends the user back to the field it is about.
  useEffect(() => {
    if (flow.nameError !== null) nameRef.current?.focus();
  }, [flow.nameError]);

  const locked = stage === "importing" || stage === "imported";
  // A failure of unknown outcome (the connection died): the import may have landed, so there is no "Try again", only Back and Close.
  const unknownOutcome = stage === "failed" && flow.importFailure?.unknownOutcome === true;
  // The event was created but opening it hangs (`IMPORT_STALL_MS`): the panel says so and carries the Close button, the footer has nothing left to offer.
  const stalled = stage === "imported" && flow.stalled;

  return (
    <form
      data-testid="import-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        flow.submit();
      }}
      className="grid gap-space-4"
    >
      <DialogHeader>
        <DialogTitle>{DIALOG_TITLE}</DialogTitle>
        <DialogDescription>{DIALOG_DESCRIPTION}</DialogDescription>
        <p data-testid="import-step" data-step={flow.step} className="text-caption text-muted-foreground">{stepIndicator(flow.step)}</p>
      </DialogHeader>

      {/* the padding keeps the focus rings of the controls inside the scrolling area */}
      <div className="-mx-1 max-h-[60vh] overflow-y-auto px-1">
        {stage === "input" && (
          <DocumentStep
            content={flow.content} onChange={flow.editContent} onFile={flow.loadFile} failure={flow.inputFailure} disabled={flow.working}
            textareaRef={documentRef}
          />
        )}
        {stage === "preview" && review?.kind === "preview" && (
          <div data-testid="import-step-review">
            <ReviewPanel preview={review.preview} eventName={flow.eventName} nameError={flow.nameError} onEventNameChange={flow.setEventName} nameRef={nameRef} />
          </div>
        )}
        {showingProblems && review?.kind === "problems" && (
          <div data-testid="import-step-review"><ProblemsPanel failure={review.failure} /></div>
        )}
        {(locked || stage === "failed") && (
          <div data-testid="import-step-importing">
            {locked && (
              <div
                ref={progressRef} tabIndex={-1} role="status" data-testid="import-progress" data-state={stage}
                className="flex items-center gap-space-3 rounded-lg border border-border/60 p-space-4 outline-none"
              >
                {!stalled && <Loader2 className="size-5 shrink-0 animate-spin text-primary" aria-hidden="true" />}
                <div className="space-y-space-1">
                  <p className="font-medium text-foreground">{stage === "imported" ? IMPORTED_HEADING : IMPORTING_HEADING}</p>
                  <p data-testid="import-progress-status" className="text-body-small text-muted-foreground">
                    {stalled ? IMPORT_STALLED : stage === "imported" ? IMPORTED_STATUS : IMPORTING_STATUS}
                  </p>
                  {stalled && (
                    <Button type="button" size="sm" data-testid="import-stalled-close" onClick={onCancel}>{CLOSE}</Button>
                  )}
                </div>
              </div>
            )}
            {stage === "failed" && flow.importFailure && <FailurePanel failure={flow.importFailure} eventName={flow.eventName.trim()} />}
          </div>
        )}
      </div>

      {!stalled && (
        <DialogFooter>
          {stage === "input" ? (
            <>
              <Button type="button" variant="outline" size="sm" data-testid="import-cancel" onClick={onCancel}>{CANCEL}</Button>
              <Button type="submit" size="sm" data-testid="import-preview" disabled={flow.content.trim() === "" || flow.working}>
                {flow.previewing ? CHECKING : PREVIEW}
              </Button>
            </>
          ) : (
            <>
              <Button ref={backRef} type="button" variant="outline" size="sm" data-testid="import-back" onClick={flow.back} disabled={locked}>{BACK}</Button>
              {unknownOutcome ? (
                // An import that may have landed must not be offered again: the user looks in the explorer first (or goes Back and previews).
                <Button type="button" size="sm" data-testid="import-close" onClick={onCancel}>{CLOSE}</Button>
              ) : !showingProblems && (
                <Button type="submit" size="sm" data-testid="import-submit" disabled={locked}>
                  {locked ? IMPORTING : stage === "failed" ? TRY_AGAIN : IMPORT}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      )}
    </form>
  );
}

function DocumentStep({ content, onChange, onFile, failure, disabled, textareaRef }: {
  content: string;
  onChange: (text: string) => void;
  onFile: (file: File) => Promise<void>;
  failure: ImportFailure | null;
  disabled: boolean;
  textareaRef: Ref<HTMLTextAreaElement>;
}) {
  return (
    <div data-testid="import-step-input" className="space-y-space-3">
      <Field label={DOCUMENT_LABEL} htmlFor="import-content" hint={DOCUMENT_HINT}>
        <Textarea
          ref={textareaRef} id="import-content" data-testid="import-content" rows={12} spellCheck={false} autoComplete="off" readOnly={disabled}
          className="max-h-[40vh] font-mono text-caption" placeholder={DOCUMENT_PLACEHOLDER} value={content} onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      <Field label={UPLOAD_LABEL} htmlFor="import-file" hint={UPLOAD_HINT}>
        <Input
          id="import-file" data-testid="import-file" type="file" accept={UPLOAD_ACCEPT} disabled={disabled}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            // cleared so that choosing the same file again (after an edit) is a change too
            e.target.value = "";
            if (picked) void onFile(picked);
          }}
        />
      </Field>
      {failure && <InputFailureAlert failure={failure} />}
    </div>
  );
}
