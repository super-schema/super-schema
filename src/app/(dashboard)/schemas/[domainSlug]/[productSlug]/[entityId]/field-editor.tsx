"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, ExternalLink, X, Search } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AutocompleteInput } from "@/components/custom/AutocompleteInput";
import { TypePicker } from "@/components/custom/TypePicker";
import { applyReferencePick, describeQualifiedName, type PickableEntity, type ReferencePick } from "@/lib/references/entity-reference";
import {
  getEntityCompleteness,
  getFieldCompleteness,
} from "@/lib/validation/field-completeness";
import { DATA_TYPE_HIERARCHY } from "@/lib/data-types";
import { readFieldCompletenessPolicy } from "@/types/schemas/field-completeness-policy";
import { classificationFilterOptions, matchesClassificationFilter } from "@/lib/classification-counts";
import { assetHref } from "@/lib/navigation/asset-href";
import { canNavigate } from "@/lib/navigation/before-navigate";
import {
  getFieldNameSuggestions,
  type AutocompleteSuggestion,
  type DomainField,
} from "@/lib/autocomplete/field-name-autocomplete";
import { suggestType } from "@/lib/autocomplete/type-suggestion";
import { writeFieldAttribute } from "@/lib/metadata-attributes/values";
import type { DictionaryEntry } from "@/types/schemas/field-dictionary";
import { FieldCard } from "./components/FieldCard";
import type { ReferenceFieldControls } from "./components/ReferencePinControl";
import { pluralize } from "@/lib/pluralize";

import { NativeSelect } from "@/components/ui/native-select";
interface FieldData {
  id: string;
  slug?: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

type NewFieldOptions = NonNullable<Parameters<FieldEditorProps["onAddField"]>[2]>;

const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };
const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

interface FieldEditorProps {
  entityId: string;
  entitySlug?: string;
  /** null for tenant-level (Enterprise) entities. */
  domainSlug: string | null;
  /** null for tenant-level (Enterprise) entities. */
  productSlug: string | null;
  fields: FieldData[];
  domainFields?: DomainField[];
  /** The tenant's field dictionary: its entries are offered first by the New Field name autocomplete. */
  dictionary?: DictionaryEntry[];
  domainPolicy: Record<string, unknown> | null;
  isReadOnly?: boolean;
  onAddField: (
    name: string,
    type: string,
    opts?: {
      description?: string;
      classification?: string | null;
      nullable?: boolean;
      isKey?: boolean;
      precision?: number | null;
      scale?: number | null;
      fieldNumber?: number | null;
      aliases?: string[];
      decorators?: Record<string, unknown>;
      dictionaryEntryId?: string | null;
    }
  ) => Promise<{ field?: { id: string; slug?: string } } | void>;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDeleteField: (id: string) => Promise<void>;
  /**
   * Saves the order of the fields (`reorderFieldsAction`): every field id, first to last. Resolves true when it was saved; false, or a throw,
   * puts the saved order back on screen.
   */
  onReorderFields: (orderedIds: string[]) => Promise<boolean>;
  onFieldSelect?: (fieldId: string) => void;
  selectedFieldId?: string | null;
  /** The pin control of reference fields (published versions of the referenced entity, pin / unpin). Keep it referentially stable. */
  referenceControls?: ReferenceFieldControls;
  /**
   * The entities of the tenant a reference can point at, with their domain and product. When given, choosing the `reference` type (in a
   * field row or in the New Field form) asks for the target and saves the qualified reference with the field.
   */
  referenceTargets?: PickableEntity[];
  toolbarAction?: ReactNode;
}

export function FieldEditor({
  entityId,
  entitySlug,
  domainSlug,
  productSlug,
  fields,
  domainFields = [],
  dictionary,
  domainPolicy,
  isReadOnly = false,
  onAddField,
  onUpdateField,
  onDeleteField,
  onReorderFields,
  onFieldSelect,
  selectedFieldId,
  referenceControls,
  referenceTargets,
  toolbarAction,
}: FieldEditorProps) {
  const router = useRouter();
  const completenessPolicy = useMemo(() => readFieldCompletenessPolicy(domainPolicy?.fieldCompleteness), [domainPolicy?.fieldCompleteness]);
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("string");
  // The target picked for a new reference field; ignored unless the type is still `reference` when the field is created.
  const [newFieldReference, setNewFieldReference] = useState<ReferencePick | null>(null);
  // Every change of the new field's type forgets the target picked for an earlier `reference` (the prompt sets it again right after).
  const chooseNewFieldType = useCallback((type: string) => {
    setNewFieldType(type);
    setNewFieldReference(null);
  }, []);

  // The dictionary entry picked for the new field (its defaults go with the field); forgotten as soon as the name stops being the entry's.
  const [newFieldDictionary, setNewFieldDictionary] = useState<AutocompleteSuggestion | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [classificationFilter, setClassificationFilter] = useState("");
  const classificationOptions = useMemo(() => classificationFilterOptions(fields.map((f) => f.classification)), [fields]);
  const [completenessFilter, setCompletenessFilter] = useState("");

  const hasActiveFilters = searchQuery || typeFilter || classificationFilter || completenessFilter;

  // Unique type categories for the type filter dropdown
  const typeCategories = useMemo(() => {
    const cats = new Map<string, string>();
    DATA_TYPE_HIERARCHY.forEach((t) => {
      if (!t.parent) {
        cats.set(t.id, t.label);
      }
    });
    return Array.from(cats.entries());
  }, []);

  // A drop shows its order at once and is saved as one list (`onReorderFields`). The shown order belongs to the `fields` it was made from: once
  // the page hands over its fields again (the save's re-render) they are the truth. A save that does not go through puts the saved order back.
  const [drop, setDrop] = useState<{ from: FieldData[]; ids: string[] } | null>(null);
  const displayedFields = useMemo(() => {
    if (!drop || drop.from !== fields) return fields;
    const byId = new Map(fields.map((f) => [f.id, f]));
    return drop.ids.flatMap((id) => byId.get(id) ?? []);
  }, [fields, drop]);

  // Apply client-side filters
  const filteredFields = useMemo(() => {
    let result = displayedFields;

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((f) => f.name.toLowerCase().includes(q));
    }

    if (typeFilter) {
      // Match exact type or types whose parent chain includes the filter
      const childTypes = DATA_TYPE_HIERARCHY
        .filter((t) => t.id === typeFilter || t.parent === typeFilter)
        .map((t) => t.id);
      result = result.filter((f) => childTypes.includes(f.type));
    }

    if (classificationFilter) {
      result = result.filter((f) => matchesClassificationFilter(f.classification, classificationFilter));
    }

    if (completenessFilter) {
      result = result.filter((f) => {
        const fc = getFieldCompleteness(f, completenessPolicy);
        if (completenessFilter === "complete") return fc.status === "complete";
        return fc.status !== "complete";
      });
    }

    return result;
  }, [displayedFields, searchQuery, typeFilter, classificationFilter, completenessFilter, completenessPolicy]);

  const navigateToFieldStudio = useCallback(
    (fieldId: string) => {
      const href = assetHref({ kind: "field", entitySlug: entitySlug || entityId, fieldId, domainSlug, productSlug });
      // The studio is a navigation like any other: a page with unsaved edits asks first (`canNavigate`), and the studio opens only when nothing vetoed it.
      if (!canNavigate(href)) return;
      router.push(href);
    },
    [router, entitySlug, entityId, domainSlug, productSlug]
  );

  // Parents hand over fresh inline handlers on every render, but FieldCard is
  // memoized. Rows get wrappers whose identity never changes and which always
  // call the latest handler, so a workspace re-render doesn't re-render every row.
  // Updated in a layout effect so an event between commit and the passive-effect
  // flush never calls a stale handler.
  const latestHandlers = useRef({ onUpdateField, onDeleteField, onFieldSelect });
  useLayoutEffect(() => {
    latestHandlers.current = { onUpdateField, onDeleteField, onFieldSelect };
  });
  const updateFieldStable = useCallback(
    (id: string, data: Partial<FieldData>) => latestHandlers.current.onUpdateField(id, data),
    []
  );
  const deleteFieldStable = useCallback(
    (id: string) => latestHandlers.current.onDeleteField(id),
    []
  );
  const selectFieldStable = useCallback(
    (fieldId: string) => latestHandlers.current.onFieldSelect?.(fieldId),
    []
  );

  // Listen for "/" slash command from global keyboard shortcuts
  useEffect(() => {
    function handleSlashCommand() {
      if (!isReadOnly) {
        setShowCreateDialog(true);
      }
    }
    document.addEventListener("super-schema:slash-command", handleSlashCommand);
    return () =>
      document.removeEventListener("super-schema:slash-command", handleSlashCommand);
  }, [isReadOnly]);

  // Close dialog on Escape
  useEffect(() => {
    if (!showCreateDialog) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setShowCreateDialog(false);
        setNewFieldName("");
        setNewFieldDictionary(null);
        chooseNewFieldType("string");
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showCreateDialog, chooseNewFieldType]);

  // Autocomplete callback
  const getNameSuggestions = useCallback(
    (query: string) =>
      getFieldNameSuggestions(query, {
        existingFieldNames: fields.map((f) => f.name),
        domainFields,
        dictionary,
        maxResults: 8,
      }),
    [fields, domainFields, dictionary]
  );

  function handleNameChange(name: string) {
    setNewFieldName(name);
    if (newFieldDictionary && name !== newFieldDictionary.value) setNewFieldDictionary(null);
    // Auto-suggest type based on field name
    const ts = suggestType(name);
    if (ts && newFieldType === "string") {
      chooseNewFieldType(ts.type);
    }
  }

  function handleNameSelect(suggestion: AutocompleteSuggestion) {
    setNewFieldName(suggestion.value);
    if (suggestion.suggestedType) {
      chooseNewFieldType(suggestion.suggestedType);
    }
    setNewFieldDictionary(suggestion.source === "dictionary" && suggestion.entryId ? suggestion : null);
  }

  /** The options a new field is created with: the qualified reference of a reference field whose target was picked, nothing otherwise. */
  function newFieldOptions(): NewFieldOptions | undefined {
    const reference = newFieldType === "reference" && newFieldReference ? applyReferencePick({}, newFieldReference) : undefined;
    const entry = newFieldDictionary;
    if (!entry) return reference ? { decorators: reference } : undefined;
    // The entry's default attribute values are written through the same writer the stored values are read with; derived members (data_class)
    // are resolved by the create action from the field's classification.
    let decorators: Record<string, unknown> | undefined = reference;
    for (const [key, value] of Object.entries(entry.attributes ?? {})) decorators = writeFieldAttribute(decorators, key, value);
    return {
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.suggestedClassification ? { classification: entry.suggestedClassification } : {}),
      ...(decorators ? { decorators } : {}),
      dictionaryEntryId: entry.entryId,
    };
  }

  function createField() {
    const opts = newFieldOptions();
    return opts ? onAddField(newFieldName.trim(), newFieldType, opts) : onAddField(newFieldName.trim(), newFieldType);
  }

  function resetDialog() {
    setShowCreateDialog(false);
    setNewFieldName("");
    setNewFieldDictionary(null);
    chooseNewFieldType("string");
  }

  async function handleCreateAndAddDetails() {
    if (!newFieldName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const result = await createField();
      const r = result as { success?: boolean; field?: { id: string; slug?: string }; error?: string } | undefined;
      if (r?.error) {
        setIsCreating(false);
        return;
      }
      const fieldSlugOrId = r?.field?.slug || r?.field?.id;
      resetDialog();
      if (fieldSlugOrId) {
        const href = assetHref({ kind: "field", entitySlug: entitySlug || entityId, fieldId: fieldSlugOrId, domainSlug, productSlug });
        // Opening the studio is guarded here too: unsaved edits on the page are asked about first, and a veto leaves the page as it is.
        if (!canNavigate(href)) return;
        // Use window.location for hard navigation — router.push gets killed by
        // revalidatePath re-rendering the parent server component
        window.location.href = href;
        return; // Don't reset isCreating — we're navigating away
      }
    } catch {
      // Allow UI to recover
    } finally {
      setIsCreating(false);
    }
  }

  async function handleQuickCreate() {
    if (!newFieldName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      const result = (await createField()) as { error?: string } | undefined;
      // A refusal (shown as a toast by the workspace) keeps the dialog open with the typed name, so it can be fixed instead of typed again.
      if (result?.error) return;
      resetDialog();
    } catch {
      // Allow UI to recover
    } finally {
      setIsCreating(false);
    }
  }

  const completeness = useMemo(() => getEntityCompleteness(fields, completenessPolicy), [fields, completenessPolicy]);

  // Drag-and-drop sensors. Stable option objects + a memoized id list keep the
  // dnd-kit contexts from changing on every render (they would otherwise
  // re-render every memoized FieldCard, because each row subscribes to them).
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  );

  const fieldIds = useMemo(() => displayedFields.map((f) => f.id), [displayedFields]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = displayedFields.findIndex((f) => f.id === active.id);
      const newIndex = displayedFields.findIndex((f) => f.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // The new order is shown at once and saved as one list of ids (one write, one revalidation on the server).
      const reordered = [...displayedFields];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      const next = { from: fields, ids: reordered.map((f) => f.id) };
      setDrop(next);

      let saved = false;
      try {
        saved = await onReorderFields(next.ids);
      } catch {
        saved = false;
      }
      // Not saved: the saved order comes back, unless a newer drop has already replaced this one.
      if (!saved) setDrop((current) => (current === next ? null : current));
    },
    [fields, displayedFields, onReorderFields]
  );

  return (
    <div>
      <div className="mb-space-3 flex min-w-0 items-center gap-space-3" data-testid="field-list-toolbar">
        <h2 className="shrink-0 text-body-small font-medium text-foreground">Fields ({fields.length})</h2>
        {fields.length > 0 && (
          <span className="min-w-0 truncate text-caption text-muted-foreground" aria-label={`${completeness.complete} of ${pluralize(completeness.total, "field")} complete`} title={`${completeness.percentage}% complete`}>
            {completeness.complete}/{completeness.total} complete
          </span>
        )}
        {toolbarAction && <div className="ml-auto shrink-0">{toolbarAction}</div>}
      </div>

      {/* Filter bar */}
      {fields.length > 3 && (
        <div className="mb-space-3 flex flex-wrap items-center gap-space-2">
          <div className="relative flex-1 min-w-[160px] max-w-[240px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search fields..."
              className="h-7 pl-7 text-body-small"
            />
          </div>
          <NativeSelect
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label="Filter by type"
            className="h-7"
          >
            <option value="">All types</option>
            {typeCategories.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </NativeSelect>
          <NativeSelect
            value={classificationFilter}
            onChange={(e) => setClassificationFilter(e.target.value)}
            aria-label="Filter by classification"
            className="h-7"
          >
            <option value="">All classifications</option>
            {classificationOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </NativeSelect>
          <NativeSelect
            value={completenessFilter}
            onChange={(e) => setCompletenessFilter(e.target.value)}
            aria-label="Filter by completeness"
            className="h-7"
          >
            <option value="">All completeness</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete</option>
          </NativeSelect>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setSearchQuery("");
                setTypeFilter("");
                setClassificationFilter("");
                setCompletenessFilter("");
              }}
              className="text-muted-foreground"
            >
              Clear filters
            </Button>
          )}
        </div>
      )}

      {/* Filtered result count */}
      {hasActiveFilters && (
        <p className="text-caption text-muted-foreground mb-space-2">
          Showing {filteredFields.length} of {pluralize(fields.length, "field")}
        </p>
      )}

      {/* Field cards */}
      {/* A fixed id keeps dnd-kit's generated aria-describedby identical on server and client (no hydration mismatch). */}
      <DndContext
        id="field-editor-dnd"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={fieldIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-1">
            {filteredFields.map((field, index) => (
              <FieldCard
                key={field.id}
                field={field}
                index={index}
                isSelected={selectedFieldId === field.id}
                isReadOnly={isReadOnly}
                onFieldSelect={selectFieldStable}
                onUpdateField={updateFieldStable}
                onDeleteField={deleteFieldStable}
                onNavigateStudio={navigateToFieldStudio}
                referenceControls={referenceControls}
                referenceTargets={referenceTargets}
                completenessPolicy={completenessPolicy}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* Inline quick-create dialog */}
      {!isReadOnly && showCreateDialog && (
        <div data-testid="new-field-form" className="mt-space-3 surface-glass rounded-xl border border-primary/20 p-space-4 space-y-space-3">
          <div className="flex items-center justify-between">
            <h4 className="text-body-small text-foreground font-medium">
              New Field
            </h4>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={resetDialog}
              className="text-muted-foreground"
              aria-label="Close new field form"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>

          {/* Name + Type row */}
          <div className="flex items-end gap-space-3">
            <div className="flex-1 min-w-0">
              <label className="text-caption text-muted-foreground mb-1 block">
                Name
              </label>
              <AutocompleteInput
                value={newFieldName}
                onChange={handleNameChange}
                onSelect={handleNameSelect}
                getSuggestions={getNameSuggestions}
                placeholder="field_name"
                className="h-8 font-mono text-body-small"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFieldName.trim()) {
                    handleCreateAndAddDetails();
                  }
                }}
              />
            </div>
            <div className="w-[140px] shrink-0">
              <label className="text-caption text-muted-foreground mb-1 block">
                Type
              </label>
              <TypePicker
                value={newFieldType}
                onChange={chooseNewFieldType}
                entities={referenceTargets}
                promptTypes={["reference"]}
                onComplexTypeConfig={referenceTargets ? (_type, config) => setNewFieldReference(config) : undefined}
              />
              {newFieldType === "reference" && newFieldReference && (
                <p data-testid="new-field-reference-target" className="mt-1 truncate font-mono text-caption text-muted-foreground">
                  → {newFieldReference.referencedQualifiedName ? describeQualifiedName(newFieldReference.referencedQualifiedName) : newFieldReference.referencedEntityName}
                </p>
              )}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-space-2">
            <Button
              size="sm"
              onClick={handleCreateAndAddDetails}
              disabled={!newFieldName.trim() || isCreating}
              className="gap-1.5"
            >
              {isCreating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ExternalLink className="w-3.5 h-3.5" />
              )}
              Create &amp; Add Details
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleQuickCreate}
              disabled={!newFieldName.trim() || isCreating}
              className="gap-1.5"
            >
              {isCreating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              Quick Create
            </Button>
          </div>
        </div>
      )}

      {/* Add field button -- opens the inline create dialog */}
      {!isReadOnly && !showCreateDialog && (
        <Button
          variant="outline"
          size="lg"
          onClick={() => setShowCreateDialog(true)}
          data-testid="field-add-button"
          className="mt-space-3 w-full gap-2 border-dashed text-muted-foreground hover:border-primary/40"
        >
          <Plus className="w-4 h-4" />
          Add Field
        </Button>
      )}
    </div>
  );
}
