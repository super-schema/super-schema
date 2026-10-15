"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";
import type { BumpKind, PublishInput } from "@/lib/entity-versioning/types";

const BUMPS: BumpKind[] = ["MINOR", "MAJOR"];

interface PublishEntityFormProps {
  entityName: string;
  preview: PublishAnalysis;
  isPublishing: boolean;
  publishError: string | null;
  onCancel: () => void;
  onConfirm: (input: PublishInput) => void | Promise<void>;
}

/** Dialog body: suggested bump, raise-only control (spec Q6), summary, blockers. */
export function PublishEntityForm({
  entityName,
  preview,
  isPublishing,
  publishError,
  onCancel,
  onConfirm,
}: PublishEntityFormProps) {
  const [bump, setBump] = useState<BumpKind>(preview.suggestedBump ?? "MINOR");
  const [summary, setSummary] = useState("");
  const blocked = preview.blockers.length > 0;
  const targetLabel = preview.candidateLabels ? preview.candidateLabels[bump] : preview.initialLabel;

  return (
    <div className="space-y-space-4">
      {blocked && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-space-3">
          <p className="flex items-center gap-1.5 text-body-small font-medium text-destructive">
            <AlertTriangle className="size-4" aria-hidden="true" /> Cannot publish yet
          </p>
          <ul className="mt-space-1 list-disc pl-5 text-caption text-foreground">
            {preview.blockers.map((b, i) => (
              <li key={`${b.kind}-${i}`}>{b.message}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.warnings.length > 0 && (
        <div
          data-testid="publish-warnings"
          className="rounded-lg border border-warning/30 bg-warning/5 p-space-3"
        >
          <p className="flex items-center gap-1.5 text-body-small font-medium text-warning">
            <AlertTriangle className="size-4" aria-hidden="true" /> Warnings
          </p>
          <ul className="mt-space-1 list-disc pl-5 text-caption text-foreground">
            {preview.warnings.map((w, i) => (
              <li key={`${w.kind}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.isFirstPublish ? (
        <p className="text-body-small text-foreground">
          First publish of <span className="font-mono">{entityName}</span>. It becomes{" "}
          <strong>v{preview.initialLabel}</strong>.
        </p>
      ) : (
        <div className="space-y-space-2">
          <p className="text-body-small text-foreground">
            Latest published: <strong>v{preview.latestLabel}</strong> · suggested bump:{" "}
            <strong>{preview.suggestedBump}</strong>
          </p>
          <div className="flex gap-space-2" role="radiogroup" aria-label="Version bump">
            {BUMPS.map((kind) => {
              const wouldLower = preview.suggestedBump === "MAJOR" && kind === "MINOR";
              return (
                <Button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={bump === kind}
                  variant={bump === kind ? "default" : "outline"}
                  size="sm"
                  disabled={wouldLower || isPublishing}
                  onClick={() => setBump(kind)}
                  data-testid={`bump-${kind.toLowerCase()}`}
                >
                  {kind === "MAJOR" ? "Major" : "Minor"} · v{preview.candidateLabels?.[kind]}
                </Button>
              );
            })}
          </div>
          {preview.suggestedBump === "MAJOR" && (
            <p className="text-caption text-muted-foreground">
              These changes are breaking, so they can only be published as a major version.
            </p>
          )}
          {preview.reasons.length > 0 && (
            <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-caption text-muted-foreground">
              {preview.reasons.map((reason, i) => (
                <li key={`${i}-${reason}`}>{reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="block">
        <span className="mb-1 block text-caption text-muted-foreground">Change summary (optional)</span>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          maxLength={500}
          disabled={isPublishing}
        />
      </label>

      {publishError && (
        <p role="alert" className="text-body-small text-destructive">
          {publishError}
        </p>
      )}

      <div className="flex justify-end gap-space-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isPublishing}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={blocked || isPublishing}
          onClick={() =>
            onConfirm({
              bump: preview.isFirstPublish ? undefined : bump,
              changeSummary: summary.trim() || undefined,
            })
          }
          data-testid="confirm-publish"
        >
          {isPublishing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          Publish v{targetLabel}
        </Button>
      </div>
    </div>
  );
}

interface PublishEntityDialogProps {
  open: boolean;
  entityName: string;
  preview: PublishAnalysis | null;
  loadError: string | null;
  isPublishing: boolean;
  publishError: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: PublishInput) => void | Promise<void>;
}

export function PublishEntityDialog({
  open,
  entityName,
  preview,
  loadError,
  isPublishing,
  publishError,
  onOpenChange,
  onConfirm,
}: PublishEntityDialogProps) {
  return (
    <Dialog
      open={open}
      modal
      disablePointerDismissal={isPublishing}
      onOpenChange={(next) => {
        if (!isPublishing) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!isPublishing} className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-heading-3 text-foreground">Publish {entityName}</DialogTitle>
          <DialogDescription className="text-body-small text-muted-foreground">
            Publishing freezes the current draft as an immutable version that messages and other entities can pin.
          </DialogDescription>
        </DialogHeader>
        {loadError ? (
          <p role="alert" className="text-body-small text-destructive">
            {loadError}
          </p>
        ) : preview === null ? (
          <p className="flex items-center gap-2 text-body-small text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking changes…
          </p>
        ) : (
          <PublishEntityForm
            key={preview.latestLabel ?? "initial"}
            entityName={entityName}
            preview={preview}
            isPublishing={isPublishing}
            publishError={publishError}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
