"use client";

import { getTypesByCategory, type DataType } from "@/lib/data-types";
import { CATEGORY_ICONS, CATEGORY_COLORS } from "./type-icons";
import { TypeGridItem } from "./TypeGridItem";

interface TypeGridProps {
  value: string;
  onSelect: (typeId: string) => void;
  /** If true, hide complex types (array, map, reference, enum, object) */
  excludeComplex?: boolean;
}

const COMPLEX_TYPE_IDS = new Set(["array", "map", "reference", "enum", "object"]);

/**
 * Build a tree structure: root types at top level, children nested under parents.
 * Supports multi-level nesting (e.g., numeric > integer > int8).
 */
function buildTypeTree(types: DataType[]): { type: DataType; children: { type: DataType; children: { type: DataType }[] }[] }[] {
  const roots: DataType[] = [];
  const childrenOf = new Map<string, DataType[]>();

  for (const t of types) {
    if (!t.parent) {
      roots.push(t);
    } else {
      const siblings = childrenOf.get(t.parent) ?? [];
      siblings.push(t);
      childrenOf.set(t.parent, siblings);
    }
  }

  return roots.map((root) => {
    const level1Children = childrenOf.get(root.id) ?? [];
    return {
      type: root,
      children: level1Children.map((child) => ({
        type: child,
        children: (childrenOf.get(child.id) ?? []).map((grandchild) => ({
          type: grandchild,
        })),
      })),
    };
  });
}

export function TypeGrid({ value, onSelect, excludeComplex }: TypeGridProps) {
  const categories = getTypesByCategory();

  const gridCategories = categories
    .map(({ category, types }) => {
      let filteredTypes = types;
      if (excludeComplex) {
        filteredTypes = filteredTypes.filter((t) => !COMPLEX_TYPE_IDS.has(t.id));
      }
      return { category, types: filteredTypes };
    })
    .filter(({ types }) => types.length > 0);

  return (
    <div className="p-2 space-y-3">
      {gridCategories.map(({ category, types }) => {
        const Icon = CATEGORY_ICONS[category];
        const iconColor = CATEGORY_COLORS[category];
        const tree = buildTypeTree(types);

        return (
          <div key={category}>
            <div className="flex items-center gap-1.5 mb-1.5 px-1">
              <Icon className={`w-3 h-3 ${iconColor}`} />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {category}
              </span>
            </div>
            <div className="space-y-0.5">
              {tree.map((node) => (
                <div key={node.type.id}>
                  {/* Root type */}
                  <div className="grid grid-cols-4 gap-1">
                    <TypeGridItem
                      icon={Icon}
                      iconColor={iconColor}
                      label={node.type.label}
                      description={node.type.description}
                      example={node.type.example}
                      isSelected={value === node.type.id}
                      onClick={() => onSelect(node.type.id)}
                    />
                  </div>
                  {/* Level 1 children */}
                  {node.children.length > 0 && (
                    <div className="ml-4 mt-0.5">
                      <div className="grid grid-cols-4 gap-1">
                        {node.children.map((child) => (
                          <TypeGridItem
                            key={child.type.id}
                            icon={Icon}
                            iconColor={iconColor}
                            label={child.type.label}
                            description={child.type.description}
                            example={child.type.example}
                            isSelected={value === child.type.id}
                            onClick={() => onSelect(child.type.id)}
                          />
                        ))}
                      </div>
                      {/* Level 2 children (grandchildren) */}
                      {node.children
                        .filter((child) => child.children.length > 0)
                        .map((child) => (
                          <div key={`${child.type.id}-children`} className="ml-4 mt-0.5">
                            <div className="grid grid-cols-4 gap-1">
                              {child.children.map((grandchild) => (
                                <TypeGridItem
                                  key={grandchild.type.id}
                                  icon={Icon}
                                  iconColor={iconColor}
                                  label={grandchild.type.label}
                                  description={grandchild.type.description}
                                  example={grandchild.type.example}
                                  isSelected={value === grandchild.type.id}
                                  onClick={() => onSelect(grandchild.type.id)}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
