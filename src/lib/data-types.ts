export interface DataType {
  id: string;
  label: string;
  typespecScalar: string;
  category: string;
  parent?: string;
  description: string;
  example?: string;
  requiresPrecision?: boolean;
  requiresScale?: boolean;
}

export const DATA_TYPE_HIERARCHY: DataType[] = [
  // ── Number ── generalized → specialized
  // Hierarchy: numeric → integer → int8/16/32/64, safeint, uint8/16/32/64
  //            numeric → float   → float32, float64
  //            numeric → decimal  → decimal128
  { id: "numeric", label: "numeric", typespecScalar: "numeric", category: "Number", description: "Any numeric value (supertype for all numbers)", example: "42, 3.14, 99999" },

  { id: "integer", label: "integer", typespecScalar: "integer", category: "Number", parent: "numeric", description: "Whole number, arbitrary precision", example: "0, 42, -100" },
  { id: "int8", label: "int8", typespecScalar: "int8", category: "Number", parent: "integer", description: "8-bit signed integer", example: "-128 … 127" },
  { id: "int16", label: "int16", typespecScalar: "int16", category: "Number", parent: "integer", description: "16-bit signed integer", example: "-32 768 … 32 767" },
  { id: "int32", label: "int32", typespecScalar: "int32", category: "Number", parent: "integer", description: "32-bit signed integer (most common)", example: "-2 147 483 648 … 2 147 483 647" },
  { id: "int64", label: "int64", typespecScalar: "int64", category: "Number", parent: "integer", description: "64-bit signed integer", example: "±9.2 × 10¹⁸" },
  { id: "safeint", label: "safeint", typespecScalar: "safeint", category: "Number", parent: "integer", description: "JavaScript-safe integer", example: "±9 007 199 254 740 991" },
  { id: "uint8", label: "uint8", typespecScalar: "uint8", category: "Number", parent: "integer", description: "8-bit unsigned integer", example: "0 … 255" },
  { id: "uint16", label: "uint16", typespecScalar: "uint16", category: "Number", parent: "integer", description: "16-bit unsigned integer", example: "0 … 65 535" },
  { id: "uint32", label: "uint32", typespecScalar: "uint32", category: "Number", parent: "integer", description: "32-bit unsigned integer", example: "0 … 4 294 967 295" },
  { id: "uint64", label: "uint64", typespecScalar: "uint64", category: "Number", parent: "integer", description: "64-bit unsigned integer", example: "0 … 1.8 × 10¹⁹" },

  { id: "float", label: "float", typespecScalar: "float", category: "Number", parent: "numeric", description: "IEEE 754 floating-point (supertype)", example: "3.14, -0.001" },
  { id: "float32", label: "float32", typespecScalar: "float32", category: "Number", parent: "float", description: "32-bit single-precision (~7 digits)", example: "3.14159" },
  { id: "float64", label: "float64", typespecScalar: "float64", category: "Number", parent: "float", description: "64-bit double-precision (~15 digits)", example: "3.141592653589793" },

  { id: "decimal", label: "decimal", typespecScalar: "decimal", category: "Number", parent: "numeric", description: "Exact decimal — no rounding (money, finance)", example: "19.99, 1234567.89", requiresPrecision: true, requiresScale: true },
  { id: "decimal128", label: "decimal128", typespecScalar: "decimal128", category: "Number", parent: "decimal", description: "128-bit decimal (34 significant digits)", example: "99999999999.99999999", requiresPrecision: true, requiresScale: true },

  // ── String ──
  { id: "string", label: "string", typespecScalar: "string", category: "String", description: "Unicode text of any length", example: '"Hello World"' },
  { id: "url", label: "url", typespecScalar: "url", category: "String", parent: "string", description: "Validated URL (RFC 3986)", example: '"https://example.com/path"' },

  // ── Boolean ──
  { id: "boolean", label: "boolean", typespecScalar: "boolean", category: "Boolean", description: "Logical true or false", example: "true, false" },

  // ── Bytes ──
  { id: "bytes", label: "bytes", typespecScalar: "bytes", category: "Bytes", description: "Raw binary data (files, images, blobs)", example: "0x48656C6C6F" },

  // ── Date & Time ──
  { id: "plainDate", label: "plainDate", typespecScalar: "plainDate", category: "Date & Time", description: "Calendar date without time or timezone", example: "2024-05-06" },
  { id: "plainTime", label: "plainTime", typespecScalar: "plainTime", category: "Date & Time", description: "Clock time without date or timezone", example: "12:34:00" },
  { id: "utcDateTime", label: "utcDateTime", typespecScalar: "utcDateTime", category: "Date & Time", description: "Date and time in UTC (most common)", example: "2024-05-06T12:20:00Z" },
  { id: "offsetDateTime", label: "offsetDateTime", typespecScalar: "offsetDateTime", category: "Date & Time", description: "Date and time with timezone offset", example: "2024-05-06T12:20:00-07:00" },
  { id: "duration", label: "duration", typespecScalar: "duration", category: "Date & Time", description: "Time span in ISO 8601 format", example: "P1Y2M3DT4H5M" },
  { id: "unixTimestamp32", label: "unixTimestamp32", typespecScalar: "unixTimestamp32", category: "Date & Time", description: "Seconds since Unix epoch (1970-01-01)", example: "1714992000" },

  // ── Structured ──
  { id: "enum", label: "enum", typespecScalar: "enum", category: "Structured", description: "Fixed set of named values", example: "ACTIVE | INACTIVE | PENDING" },
  { id: "array", label: "array", typespecScalar: "array", category: "Structured", description: "Ordered list of items of one type", example: '["a", "b", "c"]' },
  { id: "map", label: "map", typespecScalar: "Record", category: "Structured", description: "Key-value pairs (dictionary)", example: '{"key": "value"}' },
  { id: "object", label: "object", typespecScalar: "model", category: "Structured", description: "Nested model with named properties", example: "{ name: string, age: int32 }" },

  // ── Special ──
  { id: "reference", label: "reference", typespecScalar: "reference", category: "Special", description: "Foreign key reference to another entity", example: "→ Customer, → Order" },
];

export const ALL_DATA_TYPES = DATA_TYPE_HIERARCHY.map((t) => t.id);

const CATEGORIES = [
  "Number",
  "String",
  "Boolean",
  "Bytes",
  "Date & Time",
  "Structured",
  "Special",
] as const;

export type DataTypeCategory = (typeof CATEGORIES)[number];

export function getTypesByCategory(): { category: DataTypeCategory; types: DataType[] }[] {
  return CATEGORIES.map((category) => ({
    category,
    types: DATA_TYPE_HIERARCHY.filter((t) => t.category === category),
  }));
}

const typeIndex = new Map<string, DataType>();
for (const t of DATA_TYPE_HIERARCHY) {
  typeIndex.set(t.id, t);
}

export function getTypeInfo(id: string): DataType | undefined {
  return typeIndex.get(id);
}

export function isDecimalType(typeId: string): boolean {
  return typeId === "decimal" || typeId === "decimal128";
}

const COMPLEX_TYPES = new Set(["array", "map", "object", "reference"]);

export function isComplexType(typeId: string): boolean {
  return COMPLEX_TYPES.has(typeId);
}

/**
 * Format a complex type for display, e.g. "array<string>", "map<string, integer>"
 */
export function formatComplexTypeDisplay(
  type: string,
  decorators: Record<string, unknown>
): string {
  if (type === "array") {
    const elementType = (decorators.arrayElementType as string) ?? "?";
    return `array<${elementType}>`;
  }
  if (type === "map") {
    const keyType = (decorators.mapKeyType as string) ?? "?";
    const valueType = (decorators.mapValueType as string) ?? "?";
    return `map<${keyType}, ${valueType}>`;
  }
  if (type === "object") {
    const nestedFields = decorators.nestedFields as unknown[];
    const count = Array.isArray(nestedFields) ? nestedFields.length : 0;
    return `object{${count} field${count !== 1 ? "s" : ""}}`;
  }
  if (type === "reference") {
    const entityName = (decorators.referencedEntityName as string) ?? "?";
    return `ref(${entityName})`;
  }
  return type;
}
