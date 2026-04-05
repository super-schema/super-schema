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

export function TypeGrid({ value, onSelect, excludeComplex }: TypeGridProps) {
  const categories = getTypesByCategory();

  // For the grid, show only root-level types (no parent) to keep it concise
  const gridCategories = categories
    .map(({ category, types }) => {
      let rootTypes = types.filter((t) => !t.parent);
      if (excludeComplex) {
        rootTypes = rootTypes.filter((t) => !COMPLEX_TYPE_IDS.has(t.id));
      }
      return { category, types: rootTypes };
    })
    .filter(({ types }) => types.length > 0);

  return (
    <div className="p-2 space-y-3">
      {gridCategories.map(({ category, types }) => {
        const Icon = CATEGORY_ICONS[category];
        const iconColor = CATEGORY_COLORS[category];

        return (
          <div key={category}>
            <div className="flex items-center gap-1.5 mb-1.5 px-1">
              <Icon className={`w-3 h-3 ${iconColor}`} />
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {category}
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {types.map((type: DataType) => (
                <TypeGridItem
                  key={type.id}
                  icon={Icon}
                  iconColor={iconColor}
                  label={type.label}
                  description={type.description}
                  isSelected={value === type.id}
                  onClick={() => onSelect(type.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
