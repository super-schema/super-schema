"use client";

import { useState } from "react";
import { Box, ChevronDown, ChevronRight, Plus, Trash2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  addModelFieldAction,
  updateModelFieldAction,
  deleteModelFieldAction,
} from "../actions";

export interface DomainModelFieldData {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
  description: string;
}

export interface DomainModelData {
  id: string;
  name: string;
  description: string;
  extendsModelName: string | null;
  fieldCount: number;
  updatedAt: Date;
  fields: DomainModelFieldData[];
}

interface DomainModelsTabProps {
  models: DomainModelData[];
}

export function DomainModelsTab({ models }: DomainModelsTabProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [addingFieldFor, setAddingFieldFor] = useState<string | null>(null);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("string");
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editFieldName, setEditFieldName] = useState("");

  function toggle(modelId: string) {
    const next = new Set(expanded);
    next.has(modelId) ? next.delete(modelId) : next.add(modelId);
    setExpanded(next);
  }

  async function handleAddField(modelId: string) {
    if (!newFieldName.trim()) return;
    const result = await addModelFieldAction(modelId, {
      name: newFieldName.trim(),
      type: newFieldType,
    });
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success(`Field "${newFieldName}" added`);
      setNewFieldName("");
      setNewFieldType("string");
      setAddingFieldFor(null);
    }
  }

  async function handleDeleteField(fieldId: string, fieldName: string) {
    const result = await deleteModelFieldAction(fieldId);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success(`Field "${fieldName}" removed`);
    }
  }

  async function handleRenameField(fieldId: string) {
    if (!editFieldName.trim()) return;
    const result = await updateModelFieldAction(fieldId, { name: editFieldName.trim() });
    if (result.error) {
      toast.error(result.error);
    }
    setEditingField(null);
  }

  if (models.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground" data-testid="domain-models-tab">
        <Box className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-body-small">No domain models registered yet</p>
        <p className="text-caption mt-1">
          Import a TypeSpec file to populate the reusable model registry for this domain.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-space-3" data-testid="domain-models-tab">
      {models.map((model) => {
        const isExpanded = expanded.has(model.id);

        return (
          <div key={model.id} className="border border-border/50 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => toggle(model.id)}
              className="flex items-center gap-space-2 w-full px-space-4 py-space-3 hover:bg-muted/30 transition-colors"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
              )}
              <Box className="w-4 h-4 text-primary" />
              <span className="font-mono text-body-small text-foreground font-medium">
                {model.name}
              </span>
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                {model.fieldCount} fields
              </Badge>
              {model.extendsModelName && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono">
                  extends {model.extendsModelName}
                </Badge>
              )}
            </button>

            {isExpanded && (
              <div className="border-t border-border/30 px-space-4 py-space-3 space-y-space-2">
                {model.description && (
                  <p className="text-caption text-muted-foreground">{model.description}</p>
                )}

                {/* Field list with editing */}
                <div className="space-y-1">
                  {model.fields.map((field) => (
                    <div
                      key={field.id}
                      className="flex items-center gap-2 text-caption text-muted-foreground group/field py-0.5"
                    >
                      {editingField === field.id ? (
                        <Input
                          autoFocus
                          value={editFieldName}
                          onChange={(e) => setEditFieldName(e.target.value)}
                          onBlur={() => handleRenameField(field.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRenameField(field.id);
                            if (e.key === "Escape") setEditingField(null);
                          }}
                          className="h-5 w-28 font-mono text-[11px]"
                        />
                      ) : (
                        <span
                          className="font-mono text-foreground cursor-text hover:text-primary"
                          onClick={() => {
                            setEditingField(field.id);
                            setEditFieldName(field.name);
                          }}
                        >
                          {field.name}
                        </span>
                      )}
                      <span className="font-mono text-muted-foreground/60">{field.type}</span>
                      {field.isKey && <Badge variant="outline" className="text-[9px] h-3.5 px-1">key</Badge>}
                      {!field.nullable && <Badge variant="outline" className="text-[9px] h-3.5 px-1">required</Badge>}
                      {field.description && <span className="truncate flex-1">{field.description}</span>}
                      <button
                        onClick={() => handleDeleteField(field.id, field.name)}
                        className="opacity-0 group-hover/field:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                        title="Remove field"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>

                {/* Add field form */}
                {addingFieldFor === model.id ? (
                  <div className="flex items-center gap-1 mt-1">
                    <Input
                      autoFocus
                      value={newFieldName}
                      onChange={(e) => setNewFieldName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddField(model.id);
                        if (e.key === "Escape") { setAddingFieldFor(null); setNewFieldName(""); }
                      }}
                      placeholder="field name"
                      className="h-6 w-28 font-mono text-[11px]"
                    />
                    <select
                      value={newFieldType}
                      onChange={(e) => setNewFieldType(e.target.value)}
                      className="h-6 rounded border border-border bg-popover px-1 text-[10px] font-mono"
                    >
                      <option value="string">string</option>
                      <option value="int32">int32</option>
                      <option value="int64">int64</option>
                      <option value="float64">float64</option>
                      <option value="boolean">boolean</option>
                      <option value="utcDateTime">utcDateTime</option>
                      <option value="bytes">bytes</option>
                    </select>
                    <Button size="sm" className="h-6 text-[10px] px-2" onClick={() => handleAddField(model.id)}>Add</Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[10px] px-2" onClick={() => { setAddingFieldFor(null); setNewFieldName(""); }}>Cancel</Button>
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingFieldFor(model.id)}
                    className="flex items-center gap-1 text-[10px] text-primary hover:underline mt-1"
                  >
                    <Plus className="w-3 h-3" />
                    Add field
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
