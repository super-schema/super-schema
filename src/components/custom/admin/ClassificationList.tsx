"use client";

import { useState } from "react";
import { Plus, Trash2, Edit2, Shield } from "lucide-react";
import { SYSTEM_CLASSIFICATION_DEFAULTS } from "@/types/schemas/classification-taxonomy";
import type { ClassificationLevel } from "@/types/schemas/classification-taxonomy";

type ClassificationRow = ClassificationLevel;

export function ClassificationList() {
  const [levels, setLevels] = useState<ClassificationRow[]>(
    SYSTEM_CLASSIFICATION_DEFAULTS.map((d, i) => ({
      ...d,
      id: `cls-${i + 1}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
  );
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState("#8B5CF6");
  const [newDescription, setNewDescription] = useState("");
  const [newSortOrder, setNewSortOrder] = useState(5);
  const [error, setError] = useState<string | null>(null);

  function handleCreate() {
    setError(null);
    const upperName = newName.toUpperCase();
    if (levels.some((l) => l.name === upperName)) {
      setError(`Classification "${upperName}" already exists`);
      return;
    }
    const newLevel: ClassificationRow = {
      id: `cls-${levels.length + 1}`,
      name: upperName,
      displayColor: newColor,
      bgColor: `${newColor}20`,
      textColor: newColor,
      description: newDescription || null,
      sortOrder: newSortOrder,
      isSystem: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    setLevels((prev) => [...prev, newLevel].sort((a, b) => a.sortOrder - b.sortOrder));
    setShowCreate(false);
    setNewName("");
    setNewColor("#8B5CF6");
    setNewDescription("");
    setNewSortOrder(levels.length + 1);
  }

  return (
    <div className="space-y-space-4">
      {/* Add button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate(true)}
          data-testid="classification-add-open"
          className="flex items-center gap-space-2 px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small"
        >
          <Plus className="w-4 h-4" />
          Add Classification
        </button>
      </div>

      {/* Create dialog */}
      {showCreate && (
        <div data-testid="classification-form" className="border border-border rounded-lg p-space-4 space-y-space-3 bg-muted/30">
          <h4 className="text-heading-4 text-foreground">New Classification Level</h4>
          <div className="grid grid-cols-2 gap-space-3">
            <div className="space-y-space-1">
              <label htmlFor="classification-name" className="text-caption text-muted-foreground">Name</label>
              <input
                id="classification-name"
                data-testid="classification-name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., CONFIDENTIAL"
                className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none uppercase"
              />
            </div>
            <div className="space-y-space-1">
              <label className="text-caption text-muted-foreground">Color</label>
              <div className="flex items-center gap-space-2">
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer"
                />
                <input
                  type="text"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="flex-1 bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
                />
              </div>
            </div>
            <div className="space-y-space-1">
              <label htmlFor="classification-description" className="text-caption text-muted-foreground">Description</label>
              <input
                id="classification-description"
                data-testid="classification-description"
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description..."
                className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
              />
            </div>
            <div className="space-y-space-1">
              <label className="text-caption text-muted-foreground">Sort Order</label>
              <input
                type="number"
                value={newSortOrder}
                onChange={(e) => setNewSortOrder(parseInt(e.target.value) || 0)}
                className="w-full bg-muted rounded-md px-space-3 py-1.5 text-body-small text-foreground outline-none"
              />
            </div>
          </div>
          {/* Preview */}
          <div className="space-y-space-1">
            <label className="text-caption text-muted-foreground">Preview</label>
            <span
              className="inline-flex px-2 py-0.5 rounded-full text-caption"
              style={{
                backgroundColor: `${newColor}20`,
                color: newColor,
              }}
            >
              {newName.toUpperCase() || "PREVIEW"}
            </span>
          </div>
          {error && (
            <p role="alert" data-testid="classification-error" className="text-caption text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-space-2">
            <button
              onClick={handleCreate}
              data-testid="classification-create"
              disabled={!newName.trim()}
              className="px-space-3 py-1.5 rounded-md bg-primary text-primary-foreground text-body-small disabled:opacity-50"
            >
              Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setError(null); }}
              className="px-space-3 py-1.5 rounded-md text-body-small text-muted-foreground hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Classification list */}
      <div className="border border-border rounded-lg overflow-hidden">
        {levels.map((level, i) => (
          <div
            key={level.id}
            data-testid="classification-row"
            data-name={level.name}
            data-system={level.isSystem ? "true" : "false"}
            className={`flex items-center justify-between p-space-4 ${
              i < levels.length - 1 ? "border-b border-border" : ""
            }`}
          >
            <div className="flex items-center gap-space-3">
              {/* Color swatch */}
              <span
                className="w-4 h-4 rounded-full shrink-0"
                style={{ backgroundColor: level.displayColor }}
              />
              {/* Badge preview */}
              <span
                className="inline-flex px-2 py-0.5 rounded-full text-caption font-medium"
                style={{
                  backgroundColor: level.bgColor,
                  color: level.textColor,
                }}
              >
                {level.name}
              </span>
              {/* Description */}
              {level.description && (
                <span className="text-body-small text-muted-foreground">
                  {level.description}
                </span>
              )}
              {/* System badge */}
              {level.isSystem && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                  <Shield className="w-2.5 h-2.5" />
                  System
                </span>
              )}
            </div>

            <div className="flex items-center gap-space-2">
              <span className="text-caption text-muted-foreground">
                Order: {level.sortOrder}
              </span>
              <button
                className="p-1 rounded hover:bg-muted text-muted-foreground"
                title="Edit classification"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
              {!level.isSystem && (
                <button
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title="Delete classification"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
