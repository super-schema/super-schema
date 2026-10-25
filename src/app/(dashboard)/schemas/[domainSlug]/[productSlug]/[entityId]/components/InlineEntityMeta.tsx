"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Plus, X, Check, User, Clock, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { updateEntityMetadataAction, updateEntityDescriptionAction } from "../actions";
import {
  formatRetentionSummary,
  migrateSimpleRetention,
  type RetentionPolicy,
} from "@/types/schemas/retention-policy.schema";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface InlineEntityMetaProps {
  entity: {
    id: string;
    name: string;
    description: string;
    metadata: Record<string, unknown> | null;
  };
  isReadOnly: boolean;
  onGovernanceClick?: () => void;
  onMetaSaved?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InlineEntityMeta({ entity, isReadOnly, onGovernanceClick, onMetaSaved }: InlineEntityMetaProps) {
  const meta = (entity.metadata ?? {}) as Record<string, unknown>;

  // Resolve retention policy (migrate old string format if needed)
  const rawRetention = meta.retentionPolicy;
  const retentionPolicy: RetentionPolicy | null =
    rawRetention && typeof rawRetention === "object"
      ? (rawRetention as RetentionPolicy)
      : typeof rawRetention === "string" && rawRetention
        ? migrateSimpleRetention(rawRetention)
        : null;

  // Original values from entity (source of truth for dirty detection)
  const originalTags = useMemo(() => (meta.tags as string[]) ?? [], [meta.tags]);
  const originalOwner = useMemo(() => (meta.owner as string) ?? "", [meta.owner]);

  // State
  const [tags, setTags] = useState<string[]>(originalTags);
  const [owner, setOwner] = useState<string>(originalOwner);
  const [description, setDescription] = useState(entity.description ?? "");

  // Sync state when entity prop changes (e.g. after save + revalidation)
  useEffect(() => {
    setTags(originalTags);
  }, [originalTags]);

  useEffect(() => {
    setOwner(originalOwner);
  }, [originalOwner]);

  // Inline editing states
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [isEditingOwner, setIsEditingOwner] = useState(false);
  const [ownerInput, setOwnerInput] = useState(owner);
  const [isDescExpanded, setIsDescExpanded] = useState(false);
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [descInput, setDescInput] = useState(description);

  // Save status
  const [isSaving, setIsSaving] = useState(false);

  const tagInputRef = useRef<HTMLInputElement>(null);
  const ownerInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLTextAreaElement>(null);

  // Focus tag input when adding
  useEffect(() => {
    if (isAddingTag && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [isAddingTag]);

  useEffect(() => {
    if (isEditingOwner && ownerInputRef.current) {
      ownerInputRef.current.focus();
    }
  }, [isEditingOwner]);

  useEffect(() => {
    if (isEditingDesc && descInputRef.current) {
      descInputRef.current.focus();
    }
  }, [isEditingDesc]);

  // Dirty detection for tags and owner
  const isMetaDirty = useMemo(() => {
    if (owner !== originalOwner) return true;
    if (tags.length !== originalTags.length) return true;
    for (let i = 0; i < tags.length; i++) {
      if (tags[i] !== originalTags[i]) return true;
    }
    return false;
  }, [tags, owner, originalTags, originalOwner]);

  // Save metadata (tags + owner)
  async function handleMetaSave() {
    setIsSaving(true);
    try {
      await updateEntityMetadataAction(entity.id, {
        tags,
        owner: owner || null,
      });
      onMetaSaved?.();
    } catch {
      // Error state could be added here
    } finally {
      setIsSaving(false);
    }
  }

  // Discard metadata changes
  function handleMetaDiscard() {
    setTags(originalTags);
    setOwner(originalOwner);
    setOwnerInput(originalOwner);
  }

  // Tag handlers — only update local state now (no auto-save)
  function addTag(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      setTags((prev) => [...prev, trimmed]);
    }
    setTagInput("");
    setIsAddingTag(false);
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag));
  }

  // Owner handlers — only update local state now (no auto-save)
  function commitOwner() {
    const trimmed = ownerInput.trim();
    setOwner(trimmed);
    setIsEditingOwner(false);
  }

  const hasDescription = description && description.length > 0;
  const isDescLong = hasDescription && description.length > 100;

  return (
    <div className="mb-space-3 space-y-1.5" data-testid="inline-entity-meta">
      {/* Description line */}
      {hasDescription && !isEditingDesc && (
        <div className="flex items-start gap-1 group/desc">
          <p
            data-testid="entity-description"
            className={`text-body-small text-muted-foreground flex-1 ${
              isDescExpanded ? "" : "line-clamp-1"
            }`}
          >
            {description}
          </p>
          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover/desc:opacity-100 transition-opacity">
            {isDescLong && (
              <button
                onClick={() => setIsDescExpanded(!isDescExpanded)}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground"
                title={isDescExpanded ? "Collapse" : "Expand"}
              >
                {isDescExpanded ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            )}
            {!isReadOnly && (
              <button
                onClick={() => {
                  setDescInput(description);
                  setIsEditingDesc(true);
                }}
                className="p-0.5 rounded hover:bg-accent text-muted-foreground"
                title="Edit description"
                data-testid="entity-description-edit"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}

      {!hasDescription && !isReadOnly && !isEditingDesc && (
        <button
          onClick={() => {
            setDescInput("");
            setIsEditingDesc(true);
          }}
          className="text-caption text-muted-foreground hover:text-foreground transition-colors"
          data-testid="entity-add-description"
        >
          + Add description
        </button>
      )}

      {isEditingDesc && (
        <div className="flex flex-col gap-1">
          <textarea
            ref={descInputRef}
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setIsEditingDesc(false);
              }
            }}
            placeholder="Entity description..."
            data-testid="entity-description-input"
            rows={2}
            className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setIsEditingDesc(false)}
              className="px-2 py-0.5 text-caption text-muted-foreground hover:text-foreground rounded"
              data-testid="entity-description-cancel"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                setDescription(descInput);
                setIsEditingDesc(false);
                await updateEntityDescriptionAction(entity.id, descInput);
              }}
              className="px-2 py-0.5 text-caption text-primary hover:text-primary/80 rounded font-medium"
              data-testid="entity-description-save"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Meta row: tags + owner + retention + save/discard controls */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* Tags */}
        <div className="flex flex-wrap items-center gap-1" data-testid="inline-tags">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[11px] h-5 gap-0.5 pl-1.5" data-testid="inline-tag">
              {tag}
              {!isReadOnly && (
                <button
                  onClick={() => removeTag(tag)}
                  className="hover:text-destructive ml-0.5"
                  aria-label={`Remove tag ${tag}`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </Badge>
          ))}

          {/* Add tag inline */}
          {!isReadOnly && !isAddingTag && (
            <button
              onClick={() => setIsAddingTag(true)}
              className="flex items-center gap-0.5 h-5 px-1.5 rounded-full border border-dashed border-border text-caption text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
              data-testid="add-tag-button"
            >
              <Plus className="w-2.5 h-2.5" />
              tag
            </button>
          )}

          {isAddingTag && (
            <div className="flex items-center gap-0.5">
              <input
                ref={tagInputRef}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    e.preventDefault();
                    addTag(tagInput);
                  }
                  if (e.key === "Escape") {
                    setIsAddingTag(false);
                    setTagInput("");
                  }
                }}
                onBlur={() => {
                  if (tagInput.trim()) {
                    addTag(tagInput);
                  } else {
                    setIsAddingTag(false);
                  }
                }}
                placeholder="tag name"
                data-testid="inline-tag-input"
                className="h-5 w-20 rounded-full border border-input bg-transparent px-2 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
        </div>

        {/* Separator */}
        {tags.length > 0 && (
          <span className="text-border">|</span>
        )}

        {/* Owner */}
        <div className="flex items-center gap-1" data-testid="inline-owner">
          <User className="w-3 h-3 text-muted-foreground/50" />
          {!isEditingOwner ? (
            <button
              onClick={() => {
                if (!isReadOnly) {
                  setOwnerInput(owner);
                  setIsEditingOwner(true);
                }
              }}
              data-testid="inline-owner-button"
              className={`text-caption ${
                owner
                  ? "text-muted-foreground"
                  : "text-muted-foreground italic"
              } ${!isReadOnly ? "hover:text-foreground cursor-pointer" : "cursor-default"}`}
            >
              {owner || "Add owner"}
            </button>
          ) : (
            <input
              ref={ownerInputRef}
              value={ownerInput}
              onChange={(e) => setOwnerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitOwner();
                }
                if (e.key === "Escape") {
                  setIsEditingOwner(false);
                  setOwnerInput(owner);
                }
              }}
              onBlur={commitOwner}
              placeholder="owner name"
              data-testid="inline-owner-input"
              className="h-5 w-28 rounded border border-input bg-transparent px-1.5 text-caption text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>

        {/* Retention — read-only summary, click switches to Governance tab */}
        <button
          onClick={onGovernanceClick}
          className="flex items-center gap-1 group/retention"
          data-testid="inline-retention"
          title="Edit in Governance tab"
        >
          <Clock className="w-3 h-3 text-muted-foreground/50" />
          <span
            className={`text-caption ${
              retentionPolicy
                ? "text-muted-foreground group-hover/retention:text-foreground"
                : "text-muted-foreground italic group-hover/retention:text-foreground"
            } transition-colors`}
          >
            {retentionPolicy
              ? formatRetentionSummary(retentionPolicy)
              : "No retention policy"}
          </span>
        </button>

        {/* Save / Discard controls when dirty */}
        {isMetaDirty && !isReadOnly && (
          <div className="flex items-center gap-1" data-testid="meta-save-controls">
            <span className="text-[10px] text-warning">Unsaved</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleMetaDiscard}
              className="h-5 px-1.5 text-[10px]"
              data-testid="meta-discard-btn"
            >
              Discard
            </Button>
            <Button
              size="sm"
              onClick={handleMetaSave}
              disabled={isSaving}
              className="h-5 px-1.5 text-[10px]"
              data-testid="meta-save-btn"
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
