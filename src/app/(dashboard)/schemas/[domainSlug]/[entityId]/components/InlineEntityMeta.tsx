"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Plus, X, Check, User, Clock, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { updateEntityMetadataAction, updateEntityDescriptionAction } from "../actions";
import Link from "next/link";
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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InlineEntityMeta({ entity, isReadOnly }: InlineEntityMetaProps) {
  const meta = (entity.metadata ?? {}) as Record<string, unknown>;

  // Resolve retention policy (migrate old string format if needed)
  const rawRetention = meta.retentionPolicy;
  const retentionPolicy: RetentionPolicy | null =
    rawRetention && typeof rawRetention === "object"
      ? (rawRetention as RetentionPolicy)
      : typeof rawRetention === "string" && rawRetention
        ? migrateSimpleRetention(rawRetention)
        : null;

  // State
  const [tags, setTags] = useState<string[]>((meta.tags as string[]) ?? []);
  const [owner, setOwner] = useState<string>((meta.owner as string) ?? "");
  const [description, setDescription] = useState(entity.description ?? "");

  // Inline editing states
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [isEditingOwner, setIsEditingOwner] = useState(false);
  const [ownerInput, setOwnerInput] = useState(owner);
  const [isDescExpanded, setIsDescExpanded] = useState(false);
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [descInput, setDescInput] = useState(description);

  // Auto-save
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimeoutRef = useRef<NodeJS.Timeout>(undefined);
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

  // Debounced auto-save (retention is managed in governance, not here)
  const debouncedSave = useCallback(
    (newTags: string[], newOwner: string) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      setSaveStatus("saving");
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await updateEntityMetadataAction(entity.id, {
            tags: newTags,
            owner: newOwner || null,
          });
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 1500);
        } catch {
          setSaveStatus("idle");
        }
      }, 500);
    },
    [entity.id]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Tag handlers
  function addTag(value: string) {
    const trimmed = value.trim().toLowerCase();
    if (trimmed && !tags.includes(trimmed)) {
      const newTags = [...tags, trimmed];
      setTags(newTags);
      debouncedSave(newTags, owner);
    }
    setTagInput("");
    setIsAddingTag(false);
  }

  function removeTag(tag: string) {
    const newTags = tags.filter((t) => t !== tag);
    setTags(newTags);
    debouncedSave(newTags, owner);
  }

  // Owner handlers
  function commitOwner() {
    const trimmed = ownerInput.trim();
    setOwner(trimmed);
    setIsEditingOwner(false);
    debouncedSave(tags, trimmed);
  }

  // Description is part of entity, not metadata — handled separately if needed
  // For now, description editing goes through entity update, not metadata save

  const hasDescription = description && description.length > 0;
  const isDescLong = hasDescription && description.length > 100;

  return (
    <div className="mb-space-3 space-y-1.5" data-testid="inline-entity-meta">
      {/* Description line */}
      {hasDescription && !isEditingDesc && (
        <div className="flex items-start gap-1 group/desc">
          <p
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
          className="text-caption text-muted-foreground/50 hover:text-muted-foreground transition-colors"
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
            rows={2}
            className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-body-small text-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => setIsEditingDesc(false)}
              className="px-2 py-0.5 text-caption text-muted-foreground hover:text-foreground rounded"
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
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Meta row: tags + owner + retention + save indicator */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {/* Tags */}
        <div className="flex flex-wrap items-center gap-1" data-testid="inline-tags">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[11px] h-5 gap-0.5 pl-1.5">
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
              className={`text-caption ${
                owner
                  ? "text-muted-foreground"
                  : "text-muted-foreground/40 italic"
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
              className="h-5 w-28 rounded border border-input bg-transparent px-1.5 text-caption text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>

        {/* Retention — read-only summary, click navigates to governance */}
        <Link
          href={`/governance/retention?entity=${entity.id}`}
          className="flex items-center gap-1 group/retention"
          data-testid="inline-retention"
        >
          <Clock className="w-3 h-3 text-muted-foreground/50" />
          <span
            className={`text-caption ${
              retentionPolicy
                ? "text-muted-foreground group-hover/retention:text-foreground"
                : "text-muted-foreground/40 italic group-hover/retention:text-muted-foreground"
            } transition-colors`}
          >
            {retentionPolicy
              ? formatRetentionSummary(retentionPolicy)
              : "No retention policy"}
          </span>
        </Link>

        {/* Save indicator */}
        {saveStatus !== "idle" && (
          <span
            className={`text-[10px] transition-opacity ${
              saveStatus === "saving"
                ? "text-muted-foreground animate-pulse"
                : "text-success"
            }`}
            data-testid="save-indicator"
          >
            {saveStatus === "saving" ? "Saving..." : ""}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-0.5">
                <Check className="w-2.5 h-2.5" />
                Saved
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
