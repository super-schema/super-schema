"use client";

// src/features/events/builder/sections/OperationPropertiesCard.tsx
// "Operation properties (Trait)" inside an operation form: the sets applied to THIS operation. Operation sets have no schema properties,
// so a row expands to the set's metadata (read-only from the library, editable when local).
import type { DocOperation } from "@/lib/events/document/types";
import { PropertiesCard, type PropertiesCardProps } from "./PropertiesCard";

export function OperationPropertiesCard({ operation, index, ...card }: Omit<PropertiesCardProps, "kind" | "target" | "traitKeys" | "errorPointer"> & { operation: DocOperation; index: number }) {
  return <PropertiesCard {...card} kind="OPERATION" target={{ kind: "operation", key: operation.key }} traitKeys={operation.traitKeys} errorPointer={`/operations/${index}/traitKeys`} />;
}
