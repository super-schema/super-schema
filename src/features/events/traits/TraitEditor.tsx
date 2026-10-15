"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Puzzle, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import { deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { noticeFor, settleAction, type ActionNotice } from "@/lib/action-error";
import { formatJsonText, parseJsonObjectText } from "@/lib/events/inputs";
import type { EntityPin } from "@/lib/events/types";
import { ActionNoticeAlert } from "@/features/events/shared/ActionNoticeAlert";
import { EntityPinPicker } from "@/features/events/shared/EntityPinPicker";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import { JsonField } from "@/features/events/shared/JsonField";
import type { TraitPageData } from "./load-trait-page";

export function TraitEditor({ trait, owner, crumbs, listHref, entityOptions }: TraitPageData) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const [name, setName] = useState(trait.name);
  const [specText, setSpecText] = useState(formatJsonText(trait.spec) || "{}");
  const [headers, setHeaders] = useState<EntityPin | null>(trait.headers);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  async function save() {
    const spec = parseJsonObjectText(specText, "Trait object");
    if (!spec.success) return setNotice({ message: spec.error.message });
    setBusy(true);
    setNotice(null);
    try {
      // `updateTrait` is a full replace: `headers: null` unpins, and an explicit `entityVersionId: null` stays unpinned.
      const saved = await settleAction(() =>
        updateTraitAction(trait.id, owner, { name, spec: spec.data ?? {}, headers: trait.kind === "MESSAGE" ? headers : null })
      );
      if (!saved.success) return setNotice(noticeFor(saved));
      toast.success("Trait saved");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete trait "${trait.name}"?`)) return;
    setBusy(true);
    setNotice(null);
    const deleted = await settleAction(() => deleteTraitAction(trait.id, owner));
    if (!deleted.success) {
      setBusy(false);
      return setNotice(noticeFor(deleted));
    }
    void invalidateDomainsTree(); // the explorer reads a cached tree: without this the deleted row stays until a reload
    router.push(listHref); // stays busy: the page is going away, and a second click would only report "not found"
  }

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <HideEmptyRightPanel />
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-space-2 text-display text-foreground">
          <Puzzle className="w-6 h-6" /> {trait.name} <Badge variant="secondary">{trait.kind === "MESSAGE" ? "message trait" : "operation trait"}</Badge>
        </h1>
        <div className="flex gap-space-2">
          <Button variant="outline" onClick={remove} disabled={busy} data-testid="trait-delete" className="gap-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /> Delete</Button>
          <Button onClick={save} disabled={busy} data-testid="trait-save" className="gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save</Button>
        </div>
      </div>
      <ActionNoticeAlert notice={notice} testId="trait-error" />
      <label className="block max-w-md space-y-space-1">
        <span className="block text-caption text-muted-foreground">Name</span>
        <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {trait.kind === "MESSAGE" && (
        <EntityPinPicker
          id="trait-headers" label="Headers" optional entities={entityOptions} value={headers} onChange={setHeaders}
          hint="Rendered as a JSON Schema object schema (AsyncAPI requires object headers)."
        />
      )}
      <JsonField
        id="trait-spec" label="Trait object (AsyncAPI fields, e.g. summary, correlationId, bindings)" mode="object" rows={10}
        value={specText} onChange={setSpecText}
      />
    </div>
  );
}
