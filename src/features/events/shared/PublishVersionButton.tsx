"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  PublishEntityDialog,
  type PublishPreview,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";
import type { PublishInput } from "@/lib/entity-versioning/types";
import { actionErrorText, GENERIC_ACTION_ERROR, type ActionResult } from "@/types/action-result";

export interface PublishVersionButtonProps {
  subjectName: string;
  description: string;
  loadPreview: () => Promise<ActionResult<PublishPreview>>;
  publish: (input: PublishInput) => Promise<ActionResult<{ label: string }>>;
  onPublished?: (label: string) => void;
  disabled?: boolean;
  /**
   * Why the button is disabled (or its tooltip). A disabled button takes no pointer events and no focus, so its own `title` never
   * shows: the same text is also the title of the wrapper (which does receive the hover) and visible text that describes the button.
   */
  title?: string;
  testId?: string;
}

/** Publish button + the shared raise-only publish dialog (same UX as entities, spec §5.3 / §7.4). */
export function PublishVersionButton({
  subjectName, description, loadPreview, publish, onPublished, disabled, title, testId = "publish-version-button",
}: PublishVersionButtonProps) {
  const router = useRouter();
  const hintId = useId();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PublishPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  async function openDialog() {
    setOpen(true);
    setPreview(null);
    setLoadError(null);
    setPublishError(null);
    try {
      const r = await loadPreview();
      if (r.success) setPreview(r.data);
      else setLoadError(actionErrorText(r));
    } catch {
      // Without this the dialog would spin on "Checking changes…" forever. A rejected action may carry anything: never print the cause.
      setLoadError(GENERIC_ACTION_ERROR);
    }
  }

  async function confirm(input: PublishInput) {
    setPublishing(true);
    setPublishError(null);
    try {
      const r = await publish(input);
      if (!r.success) {
        setPublishError(actionErrorText(r)); // message + the service's suggested fix (a CONFLICT says to reload and publish again)
        return;
      }
      setOpen(false);
      toast.success(`Published ${subjectName} v${r.data.label}`);
      onPublished?.(r.data.label);
      router.refresh();
    } catch {
      setPublishError(GENERIC_ACTION_ERROR);
    } finally {
      // The dialog refuses to close while `isPublishing`; a thrown action must not leave it stuck.
      setPublishing(false);
    }
  }

  return (
    <>
      {/* The wrapper is always rendered, so the button is never remounted when the hint comes and goes. */}
      <span title={title} className="inline-flex items-center gap-space-2">
        {title && <span id={hintId} data-testid={`${testId}-hint`} className="text-body-small text-muted-foreground">{title}</span>}
        <Button
          variant="outline" onClick={openDialog} disabled={disabled} title={title} aria-describedby={title ? hintId : undefined}
          className="gap-1.5" data-testid={testId}
        >
          <Upload className="w-4 h-4" />
          Publish
        </Button>
      </span>
      <PublishEntityDialog
        open={open}
        entityName={subjectName}
        description={description}
        preview={preview}
        loadError={loadError}
        isPublishing={publishing}
        publishError={publishError}
        onOpenChange={setOpen}
        onConfirm={confirm}
      />
    </>
  );
}
