"use client";

import { getTypesByCategory, type DataType } from "@/lib/data-types";
import { CATEGORY_ICONS, CATEGORY_COLORS } from "./type-icons";

interface TypeGridProps {
  value: string;
  onSelect: (typeId: string) => void;
  excludeComplex?: boolean;
}

const COMPLEX_TYPE_IDS = new Set(["array", "map", "reference", "enum", "object"]);

function buildTypeTree(types: DataType[]) {
  const roots: DataType[] = [];
  const childrenOf = new Map<string, DataType[]>();
  for (const t of types) {
    if (!t.parent) roots.push(t);
    else {
      const siblings = childrenOf.get(t.parent) ?? [];
      siblings.push(t);
      childrenOf.set(t.parent, siblings);
    }
  }
  return roots.map((root) => {
    const level1 = childrenOf.get(root.id) ?? [];
    return {
      type: root,
      children: level1.map((child) => ({
        type: child,
        children: (childrenOf.get(child.id) ?? []).map((gc) => ({ type: gc })),
      })),
    };
  });
}

/**
 * Compact hierarchical type grid — shows all types visible at once.
 * Root types as labeled rows, subtypes as indented compact rows.
 * Tree connectors show generalized → specialized relationship.
 */
export function TypeGrid({ value, onSelect, excludeComplex }: TypeGridProps) {
  const categories = getTypesByCategory();

  const gridCategories = categories
    .map(({ category, types }) => ({
      category,
      types: excludeComplex ? types.filter((t) => !COMPLEX_TYPE_IDS.has(t.id)) : types,
    }))
    .filter(({ types }) => types.length > 0);

  return (
    <div className="p-1.5 space-y-1">
      {gridCategories.map(({ category, types }) => {
        const Icon = CATEGORY_ICONS[category];
        const iconColor = CATEGORY_COLORS[category];
        const tree = buildTypeTree(types);

        return (
          <div key={category}>
            {/* Category header — sticky */}
            <div className="flex items-center gap-1.5 px-2 py-1 sticky top-0 bg-popover z-10">
              <Icon className={`w-3 h-3 ${iconColor}`} />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                {category}
              </span>
            </div>

            {/* Types — compact rows with tree connectors */}
            <div className="space-y-px">
              {tree.map((node) => {
                const hasChildren = node.children.length > 0;
                return (
                  <div key={node.type.id}>
                    <TypeRow
                      type={node.type}
                      isSelected={value === node.type.id}
                      onSelect={onSelect}
                      isParent={hasChildren}
                    />
                    {hasChildren && (
                      <div className="ml-3 border-l border-border/30 pl-2">
                        {node.children.map((child) => (
                          <div key={child.type.id}>
                            <TypeRow
                              type={child.type}
                              isSelected={value === child.type.id}
                              onSelect={onSelect}
                              isParent={child.children.length > 0}
                              isChild
                            />
                            {child.children.length > 0 && (
                              <div className="ml-3 border-l border-border/20 pl-2">
                                {child.children.map((gc) => (
                                  <TypeRow
                                    key={gc.type.id}
                                    type={gc.type}
                                    isSelected={value === gc.type.id}
                                    onSelect={onSelect}
                                    isChild
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Compact row for a single type */
function TypeRow({
  type,
  isSelected,
  onSelect,
  isParent,
  isChild,
}: {
  type: DataType;
  isSelected: boolean;
  onSelect: (id: string) => void;
  isParent?: boolean;
  isChild?: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(type.id)}
      className={`w-full flex items-center gap-2 px-2 py-1 rounded transition-colors text-left ${
        isSelected
          ? "bg-primary/15 text-foreground"
          : "hover:bg-accent/40 text-muted-foreground hover:text-foreground"
      }`}
      title={type.description}
    >
      <span className={`font-mono shrink-0 ${isChild ? "text-[11px]" : "text-xs font-medium"} ${isSelected ? "text-primary" : ""}`}>
        {type.label}
      </span>
      {isParent && (
        <span className="text-[9px] text-muted-foreground/40">▸</span>
      )}
      {type.example && (
        <span className={`text-[10px] font-mono truncate flex-1 text-right ${
          isSelected ? "text-primary/60" : "text-muted-foreground/40"
        }`}>
          {type.example}
        </span>
      )}
    </button>
  );
}
