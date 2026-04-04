"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Extensions } from "@/types/schemas/typespec-decorator.schema";

interface ExtensionsPanelProps {
  extensions: Extensions;
  showXml?: boolean;
  onChange: (extensions: Extensions) => void;
}

export function ExtensionsPanel({
  extensions,
  showXml = false,
  onChange,
}: ExtensionsPanelProps) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  function update(partial: Partial<Extensions>) {
    onChange({ ...extensions, ...partial });
  }

  const openapiEntries = Object.entries(extensions.openapi ?? {});
  const xml = extensions.xml ?? {};
  const activeCount =
    openapiEntries.length +
    Object.values(xml).filter((v) => v != null && v !== false && v !== "")
      .length;

  function addExtension() {
    const key = newKey.trim();
    if (!key) return;

    // Auto-prefix x- if not present
    const prefixedKey = key.startsWith("x-") ? key : `x-${key}`;

    // Try parsing as JSON for complex values
    let parsedValue: unknown = newValue;
    if (newValue.trim().startsWith("{") || newValue.trim().startsWith("[")) {
      try {
        parsedValue = JSON.parse(newValue);
        setJsonError(null);
      } catch (e) {
        setJsonError("Invalid JSON");
        return;
      }
    } else if (newValue === "true") {
      parsedValue = true;
    } else if (newValue === "false") {
      parsedValue = false;
    } else if (!isNaN(Number(newValue)) && newValue.trim() !== "") {
      parsedValue = Number(newValue);
    }

    update({
      openapi: {
        ...(extensions.openapi ?? {}),
        [prefixedKey]: parsedValue,
      },
    });
    setNewKey("");
    setNewValue("");
    setJsonError(null);
  }

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Active count badge */}
      {activeCount > 0 && (
        <Badge variant="secondary" className="text-[10px]">
          {activeCount} active extension{activeCount !== 1 ? "s" : ""}
        </Badge>
      )}

      {/* OpenAPI @extension key-value editor */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          @extension (OpenAPI x-* properties)
        </label>
        <div className="space-y-1">
          {openapiEntries.map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-caption font-mono text-muted-foreground w-40 truncate">
                {key}
              </span>
              <span className="text-caption text-muted-foreground/50">=</span>
              <span className="text-caption font-mono text-foreground truncate flex-1">
                {typeof val === "object" ? JSON.stringify(val) : String(val)}
              </span>
              <button
                onClick={() => {
                  const next = { ...(extensions.openapi ?? {}) };
                  delete next[key];
                  update({ openapi: next });
                }}
                className="p-0.5 text-muted-foreground hover:text-destructive shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {/* Add new extension */}
          <div className="flex items-center gap-2">
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="x-property-name"
              className="h-6 text-caption w-40 font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") addExtension();
              }}
            />
            <span className="text-caption text-muted-foreground/50">=</span>
            <Input
              value={newValue}
              onChange={(e) => {
                setNewValue(e.target.value);
                setJsonError(null);
              }}
              placeholder="value"
              className="h-6 text-caption flex-1 font-mono"
              onKeyDown={(e) => {
                if (e.key === "Enter") addExtension();
              }}
            />
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={!newKey.trim()}
              onClick={addExtension}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
          {jsonError && (
            <span className="text-[10px] text-destructive">{jsonError}</span>
          )}
        </div>
      </div>

      {/* XML decorators — only shown when XML emitter is active */}
      {showXml && (
      <div className="border-t border-border/50 pt-space-3">
        <label className="text-caption text-muted-foreground mb-2 block">
          XML Decorators
        </label>
        <div className="space-y-space-2">
          <div className="flex items-center gap-space-4">
            <label className="flex items-center gap-2 text-caption text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={xml.attribute ?? false}
                onChange={(e) =>
                  update({ xml: { ...xml, attribute: e.target.checked } })
                }
                className="accent-primary"
              />
              @xmlAttribute
            </label>
            <label className="flex items-center gap-2 text-caption text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={xml.element ?? false}
                onChange={(e) =>
                  update({ xml: { ...xml, element: e.target.checked } })
                }
                className="accent-primary"
              />
              @xmlElement
            </label>
          </div>

          <div className="flex items-center gap-space-3">
            <div className="flex-1">
              <label className="text-[10px] text-muted-foreground mb-0.5 block">
                @xmlNamespace URI
              </label>
              <Input
                value={xml.namespace ?? ""}
                onChange={(e) =>
                  update({ xml: { ...xml, namespace: e.target.value || null } })
                }
                placeholder="http://example.com/ns"
                className="h-6 text-caption font-mono"
              />
            </div>
            <div className="w-24">
              <label className="text-[10px] text-muted-foreground mb-0.5 block">
                Prefix
              </label>
              <Input
                value={xml.namespacePrefix ?? ""}
                onChange={(e) =>
                  update({
                    xml: { ...xml, namespacePrefix: e.target.value || null },
                  })
                }
                placeholder="ns"
                className="h-6 text-caption font-mono"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground mb-0.5 block">
              @xmlName (override element name)
            </label>
            <Input
              value={xml.name ?? ""}
              onChange={(e) =>
                update({ xml: { ...xml, name: e.target.value || null } })
              }
              placeholder="Use field name"
              className="h-6 text-caption font-mono w-48"
            />
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
