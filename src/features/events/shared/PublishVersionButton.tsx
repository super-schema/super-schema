"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  PublishEntityDialog,
  type PublishPreview,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";
import type { PublishInput } from "@/lib/entity-versioning/types";
import type { ActionResult } from "@/types/action-result";

function errorMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Unexpected error";
}

export interface PublishVersionButtonProps {
  subjectName: string;
  description: string;
  loadPreview: () => Promise<ActionResult<PublishPreview>>;
  publish: (input: PublishInput) => Promise<ActionResult<{ label: string }>>;
  onPublished?: (label: string) => void;
  disabled?: boolean;
  testId?: string;
}

/** Publish button + the shared raise-only publish dialog (same UX as entities, spec §5.3 / §7.4). */
export function PublishVersionButton({
  subjectName, description, loadPreview, publish, onPublished, disabled, testId = "publish-version-button",
}: PublishVersionButtonProps) {
  const router = useRouter();
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
      else setLoadError(r.error);
    } catch (e) {
      // Without this the dialog would spin on "Checking changes…" forever.
      setLoadError(`Could not load the publish preview: ${errorMessage(e)}`);
    }
  }

  async function confirm(input: PublishInput) {
    setPublishing(true);
    setPublishError(null);
    try {
      const r = await publish(input);
      if (!r.success) {
        setPublishError(r.error);
        return;
      }
      setOpen(false);
      toast.success(`Published ${subjectName} v${r.data.label}`);
      onPublished?.(r.data.label);
      router.refresh();
    } catch (e) {
      setPublishError(`Publishing failed: ${errorMessage(e)}`);
    } finally {
      // The dialog refuses to close while `isPublishing`; a thrown action must not leave it stuck.
      setPublishing(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={openDialog} disabled={disabled} className="gap-1.5" data-testid={testId}>
        <Upload className="w-4 h-4" />
        Publish
      </Button>
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
