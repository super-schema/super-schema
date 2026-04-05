/**
 * Lucide icon mapping per data type category.
 * Used by the TypeGrid to display visual tiles.
 */

import {
  Hash,
  Type,
  ToggleLeft,
  FileCode,
  Calendar,
  Layers,
  Link,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DataTypeCategory } from "@/lib/data-types";

export const CATEGORY_ICONS: Record<DataTypeCategory, LucideIcon> = {
  "Number": Hash,
  "String": Type,
  "Boolean": ToggleLeft,
  "Bytes": FileCode,
  "Date & Time": Calendar,
  "Structured": Layers,
  "Special": Link,
};

export const CATEGORY_COLORS: Record<DataTypeCategory, string> = {
  "Number": "text-blue-400",
  "String": "text-emerald-400",
  "Boolean": "text-amber-400",
  "Bytes": "text-purple-400",
  "Date & Time": "text-rose-400",
  "Structured": "text-cyan-400",
  "Special": "text-orange-400",
};
