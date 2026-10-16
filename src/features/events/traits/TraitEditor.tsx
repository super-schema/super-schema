"use client";

// src/features/events/traits/TraitEditor.tsx
// The library page of one set of message properties (Enterprise / Domain level; "Trait" in brackets for the technical name).
//
//  - A MESSAGE set shows the same Properties table as the event builder (it writes `spec.headers`), and the rest of the AsyncAPI message
//    trait (title, summary, description, content type, correlation id, examples, tags, docs, bindings…) under a collapsed "More details".
//  - An OPERATION set has no schema properties: its metadata (title, summary, description) up front, the rest under "More details".
//  - A BUILT-IN set (CloudEvents, W3C Trace Context) opens read-only: a lock, the explanation, its properties, no Save and no Delete (the
//    service refuses to change or delete it too).
//  - The headers entity picker is gone. A set that already has a headers entity pin keeps it: a read-only note names the entity, and the pin
//    is sent back unchanged on every save (`updateTrait` is a full replace: leaving it out would unpin it).
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, Lock, Puzzle, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HideEmptyRightPanel } from "@/components/layout/HideEmptyRightPanel";
import { deleteTraitAction, updateTraitAction } from "@/app/(dashboard)/schemas/trait-actions";
import { useInvalidateDomainsTree } from "@/hooks/useDomainsTree";
import { noticeFor, settleAction, type ActionNotice } from "@/lib/action-error";
import type { JsonObject } from "@/lib/event-specs/types";
import { isBundledTrait, propertySummary } from "@/lib/events/bundled-traits";
import { TEMPLATES } from "@/lib/events/templates";
import { ActionNoticeAlert } from "@/features/events/shared/ActionNoticeAlert";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import {
  BUILT_IN_BADGE, BUILT_IN_NOTE, builtInExplanation, propertiesName, propertiesNameLower, propertiesTitle, propertyCountText, TRAIT_BADGE,
} from "@/features/events/builder/labels";
import { bindingCount, cardTemplate, pickValue, setFieldCount } from "@/features/events/builder/sections/form-cards";
import { LockedNote, PropertiesTable } from "@/features/events/builder/sections/PropertiesTable";
import { BindingsForm, TemplateForm } from "@/features/events/builder/template";
import { isEmptyValue, setField } from "@/features/events/builder/template/value";
import type { TraitPageData } from "./load-trait-page";

/**
 * The template fields shown up front and under "More details", per kind. A message set's identity is the library name above (its AsyncAPI
 * `name` is kept as it is, listed under "Other properties"); an operation set's `security` points at document schemes, which a library page
 * does not have, so it is kept as it is too.
 */
const PRIMARY_KEYS = { MESSAGE: [], OPERATION: ["title", "summary", "description"] } as const;
const MORE_KEYS = {
  MESSAGE: ["title", "summary", "description", "contentType", "correlationId", "examples", "tags", "externalDocs", "deprecated"],
  OPERATION: ["tags", "externalDocs"],
} as const;

const omit = (spec: JsonObject, key: string): JsonObject => {
  const next = { ...spec };
  delete next[key];
  return next;
};

export function TraitEditor({ trait, owner, crumbs, listHref, entityOptions }: TraitPageData) {
  const router = useRouter();
  const invalidateDomainsTree = useInvalidateDomainsTree();
  const builtIn = isBundledTrait(trait.spec);
  const kind = trait.kind;
  const [name, setName] = useState(trait.name);
  const [spec, setSpec] = useState<JsonObject>(trait.spec);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  const template = kind === "MESSAGE" ? TEMPLATES.messageTrait : TEMPLATES.operationTrait;
  const primary: readonly string[] = PRIMARY_KEYS[kind];
  const more: readonly string[] = MORE_KEYS[kind];
  const known = useMemo(() => new Set<string>([...primary, ...more, "bindings", "headers"]), [primary, more]);
  const unknownKeys = Object.keys(spec).filter((k) => !known.has(k));
  const moreCount = setFieldCount(template, more, spec) + (bindingCount(spec.bindings) > 0 ? 1 : 0);
  const pin = trait.headers;
  const pinName = pin ? entityOptions.find((e) => e.id === pin.entityId)?.name ?? pin.entityId : null;
  const count = propertySummary(spec).length;

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      // `updateTrait` is a full replace: `headers: null` unpins, so the stored pin goes back unchanged (an explicit `entityVersionId: null` stays unpinned).
      const saved = await settleAction(() =>
        updateTraitAction(trait.id, owner, { name, spec, headers: kind === "MESSAGE" ? trait.headers : null })
      );
      if (!saved.success) return setNotice(noticeFor(saved));
      toast.success(`${propertiesName(kind)} saved`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${propertiesNameLower(kind)} "${trait.name}"?`)) return;
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

  /** A template form for some fields of the set: it sees only those keys and its edits are merged into `spec`. */
  const specForm = (keys: readonly string[], disabled?: boolean) => (
    <TemplateForm
      template={cardTemplate(template, keys)} value={pickValue(spec, keys)} idPrefix="trait-editor" disabled={disabled} compactHelp
      onChange={(next) => setSpec((s) => {
        let out: Record<string, unknown> = s;
        for (const k of keys) out = setField(out, k, next[k]);
        return out as JsonObject;
      })}
    />
  );

  return (
    <div className="animate-auth-fade-up space-y-space-6">
      <HideEmptyRightPanel />
      <EventBreadcrumb crumbs={crumbs} />
      <div className="flex flex-wrap items-center justify-between gap-space-3">
        <div className="space-y-space-1">
          <h1 className="flex flex-wrap items-center gap-space-2 text-display text-foreground">
            <Puzzle className="w-6 h-6" /> {trait.name}
            <Badge variant="outline" data-testid="trait-editor-badge">{TRAIT_BADGE}</Badge>
            <Badge variant="secondary">{kind === "MESSAGE" ? "Message" : "Operation"}</Badge>
            {builtIn && <Badge variant="secondary" className="gap-1" data-testid="trait-editor-builtin-badge"><Lock aria-hidden="true" />{BUILT_IN_BADGE}</Badge>}
          </h1>
          <p data-testid="trait-editor-subtitle" className="text-body-small text-muted-foreground">{propertiesTitle(kind)}</p>
        </div>
        {!builtIn && (
          <div className="flex gap-space-2">
            <Button variant="outline" onClick={remove} disabled={busy} data-testid="trait-delete" className="gap-1.5 text-muted-foreground hover:text-destructive"><Trash2 className="w-4 h-4" /> Delete</Button>
            <Button onClick={save} disabled={busy} data-testid="trait-save" className="gap-1.5">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save</Button>
          </div>
        )}
      </div>
      <ActionNoticeAlert notice={notice} testId="trait-error" />

      {builtIn ? (
        <div className="max-w-3xl space-y-space-4" data-testid="trait-editor-readonly">
          <LockedNote id="trait-editor-builtin-note">{`${BUILT_IN_NOTE}. ${builtInExplanation(trait.name)}`}</LockedNote>
          {typeof spec.description === "string" && <p data-testid="trait-editor-description" className="text-body-small text-foreground">{spec.description}</p>}
          {kind === "MESSAGE" && (
            <section aria-labelledby="trait-editor-properties-heading" className="space-y-space-2">
              <h2 id="trait-editor-properties-heading" className="text-heading-3 text-foreground">
                Properties <span className="text-body-small font-normal text-muted-foreground">{propertyCountText(count)}</span>
              </h2>
              <PropertiesTable idPrefix="trait-editor-props" headers={spec.headers} readOnly />
            </section>
          )}
        </div>
      ) : (
        <div className="max-w-3xl space-y-space-4" data-testid="trait-editor-form">
          <label className="block max-w-md space-y-space-1">
            <span className="block text-caption text-muted-foreground">Name</span>
            <Input aria-label="Name" data-testid="trait-editor-name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {kind === "OPERATION" && specForm(primary)}
          {kind === "MESSAGE" && (
            <section aria-labelledby="trait-editor-properties-heading" className="space-y-space-2">
              <h2 id="trait-editor-properties-heading" className="text-heading-3 text-foreground">Properties</h2>
              <PropertiesTable
                idPrefix="trait-editor-props" headers={spec.headers}
                onChange={(headers) => setSpec((s) => (headers === undefined ? omit(s, "headers") : { ...s, headers }))}
              />
              {pinName && (
                <p data-testid="trait-editor-headers-note" className="text-caption text-muted-foreground">Headers come from the entity {pinName}.</p>
              )}
            </section>
          )}

          <section className="rounded-lg border border-border">
            <h2 className="text-body font-medium text-foreground">
              <button
                type="button" data-testid="trait-editor-more-toggle" aria-expanded={moreOpen} aria-controls="trait-editor-more" onClick={() => setMoreOpen(!moreOpen)}
                className="flex w-full items-center gap-space-2 rounded-lg px-space-4 py-space-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {moreOpen ? <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
                <span>More details</span>
                <Badge variant="secondary" data-testid="trait-editor-more-count">{moreCount}</Badge>
              </button>
            </h2>
            {moreOpen && (
              <div id="trait-editor-more" data-testid="trait-editor-more" role="region" aria-label="More details" className="space-y-space-4 border-t border-border p-space-4">
                {specForm(more)}
                <BindingsForm
                  target={kind === "MESSAGE" ? "message" : "operation"} value={(spec.bindings ?? {}) as Record<string, unknown>} idPrefix="trait-editor-bindings"
                  onChange={(next) => setSpec((s) => (isEmptyValue(next) ? omit(s, "bindings") : { ...s, bindings: next as JsonObject }))}
                />
                {unknownKeys.length > 0 && (
                  <p data-testid="trait-editor-other" className="text-caption text-muted-foreground">{`Other properties (kept as they are): ${unknownKeys.join(", ")}`}</p>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
