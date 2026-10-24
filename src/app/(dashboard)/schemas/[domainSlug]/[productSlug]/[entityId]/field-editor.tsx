"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
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
import { applyReferencePick, type PickableEntity, type ReferencePick } from "@/lib/references/entity-reference";
import {
  getEntityCompleteness,
  getFieldCompleteness,
} from "@/lib/validation/field-completeness";
import { DATA_TYPE_HIERARCHY } from "@/lib/data-types";
import { classificationFilterOptions, matchesClassificationFilter } from "@/lib/classification-counts";
import { assetHref } from "@/lib/navigation/asset-href";
import {
  getFieldNameSuggestions,
  type AutocompleteSuggestion,
  type DomainField,
} from "@/lib/autocomplete/field-name-autocomplete";
import { suggestType } from "@/lib/autocomplete/type-suggestion";
import { FieldCard } from "./components/FieldCard";
import type { ReferenceFieldControls } from "./components/ReferencePinControl";
import { pluralize } from "@/lib/pluralize";

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
    }
  ) => Promise<{ field?: { id: string; slug?: string } } | void>;
  onUpdateField: (id: string, data: Partial<FieldData>) => Promise<void>;
  onDeleteField: (id: string) => Promise<void>;
  onFieldSelect?: (fieldId: string) => void;
  selectedFieldId?: string | null;
  /** The pin control of reference fields (published versions of the referenced entity, pin / unpin). Keep it referentially stable. */
  referenceControls?: ReferenceFieldControls;
  /**
   * The entities of the tenant a reference can point at, with their domain and product. When given, choosing the `reference` type (in a
   * field row or in the New Field form) asks for the target and saves the qualified reference with the field.
   */
  referenceTargets?: PickableEntity[];
}

export function FieldEditor({
  entityId,
  entitySlug,
  domainSlug,
  productSlug,
  fields,
  domainFields = [],
  domainPolicy,
  isReadOnly = false,
  onAddField,
  onUpdateField,
  onDeleteField,
  onFieldSelect,
  selectedFieldId,
  referenceControls,
  referenceTargets,
}: FieldEditorProps) {
  const router = useRouter();
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

  // Apply client-side filters
  const filteredFields = useMemo(() => {
    let result = fields;

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
        const fc = getFieldCompleteness(f);
        if (completenessFilter === "complete") return fc.status === "complete";
        return fc.status !== "complete";
      });
    }

    return result;
  }, [fields, searchQuery, typeFilter, classificationFilter, completenessFilter]);

  const navigateToFieldStudio = useCallback(
    (fieldId: string) => {
      router.push(assetHref({ kind: "field", entitySlug: entitySlug || entityId, fieldId, domainSlug, productSlug }));
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
        maxResults: 8,
      }),
    [fields, domainFields]
  );

  function handleNameChange(name: string) {
    setNewFieldName(name);
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
  }

  /** The options a new field is created with: the qualified reference of a reference field whose target was picked, nothing otherwise. */
  function newFieldOptions(): { decorators: Record<string, unknown> } | undefined {
    if (newFieldType !== "reference" || !newFieldReference) return undefined;
    return { decorators: applyReferencePick({}, newFieldReference) };
  }

  function createField() {
    const opts = newFieldOptions();
    return opts ? onAddField(newFieldName.trim(), newFieldType, opts) : onAddField(newFieldName.trim(), newFieldType);
  }

  function resetDialog() {
    setShowCreateDialog(false);
    setNewFieldName("");
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
        // Use window.location for hard navigation — router.push gets killed by
        // revalidatePath re-rendering the parent server component
        window.location.href = assetHref({ kind: "field", entitySlug: entitySlug || entityId, fieldId: fieldSlugOrId, domainSlug, productSlug });
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

  const completeness = getEntityCompleteness(fields);

  // Drag-and-drop sensors. Stable option objects + a memoized id list keep the
  // dnd-kit contexts from changing on every render (they would otherwise
  // re-render every memoized FieldCard, because each row subscribes to them).
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  );

  const fieldIds = useMemo(() => fields.map((f) => f.id), [fields]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = fields.findIndex((f) => f.id === active.id);
      const newIndex = fields.findIndex((f) => f.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Build the reordered list
      const reordered = [...fields];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      // Update sortOrder for all fields that changed position
      const updates: Promise<void>[] = [];
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].sortOrder !== i) {
          updates.push(onUpdateField(reordered[i].id, { sortOrder: i }));
        }
      }
      await Promise.all(updates);
    },
    [fields, onUpdateField]
  );

  return (
    <div>
      {/* Progress bar */}
      {fields.length > 0 && (
        <div className="mb-space-4">
          <div className="flex items-center justify-between mb-space-1">
            <span className="text-caption text-muted-foreground">
              {completeness.complete} of {pluralize(completeness.total, "field")} complete
            </span>
            <span className="text-caption text-muted-foreground">
              {completeness.percentage}%
            </span>
          </div>
          <div className="h-1 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-success rounded-full transition-all duration-300"
              style={{ width: `${completeness.percentage}%` }}
            />
          </div>
        </div>
      )}

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
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All types</option>
            {typeCategories.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <select
            value={classificationFilter}
            onChange={(e) => setClassificationFilter(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All classifications</option>
            {classificationOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            value={completenessFilter}
            onChange={(e) => setCompletenessFilter(e.target.value)}
            className="h-7 rounded-md border border-input bg-transparent px-2 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All completeness</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete</option>
          </select>
          {hasActiveFilters && (
            <button
              onClick={() => {
                setSearchQuery("");
                setTypeFilter("");
                setClassificationFilter("");
                setCompletenessFilter("");
              }}
              className="text-caption text-muted-foreground hover:text-foreground transition-colors"
            >
              Clear filters
            </button>
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
            <button
              onClick={resetDialog}
              className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded"
            >
              <X className="w-4 h-4" />
            </button>
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
                  → {newFieldReference.referencedQualifiedName?.split("/").join(" / ") ?? newFieldReference.referencedEntityName}
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
        <button
          onClick={() => setShowCreateDialog(true)}
          data-testid="field-add-button"
          className="mt-space-3 w-full flex items-center justify-center gap-2 py-space-3 rounded-lg border border-dashed border-border hover:border-primary/40 hover:bg-accent/20 text-muted-foreground hover:text-foreground transition-colors text-body-small"
        >
          <Plus className="w-4 h-4" />
          Add Field
        </button>
      )}
    </div>
  );
}
