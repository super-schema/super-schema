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
  // Number category
  { id: "numeric", label: "Number", typespecScalar: "numeric", category: "Number", description: "Any numeric value", example: "42" },
  { id: "integer", label: "Integer", typespecScalar: "integer", category: "Number", parent: "numeric", description: "Whole number (arbitrary precision)", example: "100" },
  { id: "int8", label: "int8", typespecScalar: "int8", category: "Number", parent: "integer", description: "8-bit signed integer (-128 to 127)", example: "-128 to 127" },
  { id: "int16", label: "int16", typespecScalar: "int16", category: "Number", parent: "integer", description: "16-bit signed integer (-32768 to 32767)", example: "-32768 to 32767" },
  { id: "int32", label: "int32", typespecScalar: "int32", category: "Number", parent: "integer", description: "32-bit signed integer", example: "-2B to 2B" },
  { id: "int64", label: "int64", typespecScalar: "int64", category: "Number", parent: "integer", description: "64-bit signed integer", example: "large integers" },
  { id: "safeint", label: "safeint", typespecScalar: "safeint", category: "Number", parent: "integer", description: "Safe integer (JS Number.MAX_SAFE_INTEGER)", example: "JS safe" },
  { id: "uint8", label: "uint8", typespecScalar: "uint8", category: "Number", parent: "integer", description: "8-bit unsigned integer (0 to 255)", example: "0-255" },
  { id: "uint16", label: "uint16", typespecScalar: "uint16", category: "Number", parent: "integer", description: "16-bit unsigned integer (0 to 65535)", example: "0-65535" },
  { id: "uint32", label: "uint32", typespecScalar: "uint32", category: "Number", parent: "integer", description: "32-bit unsigned integer", example: "0-4B" },
  { id: "uint64", label: "uint64", typespecScalar: "uint64", category: "Number", parent: "integer", description: "64-bit unsigned integer", example: "large unsigned" },
  { id: "float", label: "Float", typespecScalar: "float", category: "Number", parent: "numeric", description: "Floating-point number", example: "3.14" },
  { id: "float32", label: "float32", typespecScalar: "float32", category: "Number", parent: "float", description: "32-bit IEEE 754 floating-point", example: "3.14" },
  { id: "float64", label: "float64", typespecScalar: "float64", category: "Number", parent: "float", description: "64-bit IEEE 754 floating-point", example: "precise decimals" },
  { id: "decimal", label: "Decimal", typespecScalar: "decimal", category: "Number", parent: "numeric", description: "Exact decimal number", example: "19.99", requiresPrecision: true, requiresScale: true },
  { id: "decimal128", label: "decimal128", typespecScalar: "decimal128", category: "Number", parent: "decimal", description: "128-bit decimal floating-point", example: "high precision", requiresPrecision: true, requiresScale: true },

  // String category
  { id: "string", label: "String", typespecScalar: "string", category: "String", description: "Unicode text value", example: '"Hello World"' },
  { id: "url", label: "url", typespecScalar: "url", category: "String", parent: "string", description: "URL string", example: '"https://example.com"' },

  // Boolean category
  { id: "boolean", label: "Boolean", typespecScalar: "boolean", category: "Boolean", description: "True or false value", example: "true / false" },

  // Bytes category
  { id: "bytes", label: "Bytes", typespecScalar: "bytes", category: "Bytes", description: "Binary data", example: "binary data" },

  // Date & Time category
  { id: "plainDate", label: "plainDate", typespecScalar: "plainDate", category: "Date & Time", description: "Date without time or timezone (YYYY-MM-DD)", example: "2024-05-06" },
  { id: "plainTime", label: "plainTime", typespecScalar: "plainTime", category: "Date & Time", description: "Time without date or timezone (HH:mm:ss)", example: "12:34:00" },
  { id: "utcDateTime", label: "utcDateTime", typespecScalar: "utcDateTime", category: "Date & Time", description: "Date and time in UTC", example: "2024-05-06T12:20:00Z" },
  { id: "offsetDateTime", label: "offsetDateTime", typespecScalar: "offsetDateTime", category: "Date & Time", description: "Date and time with UTC offset", example: "2024-05-06T12:20:00-07:00" },
  { id: "duration", label: "duration", typespecScalar: "duration", category: "Date & Time", description: "ISO 8601 duration", example: "P1Y1D" },
  { id: "unixTimestamp32", label: "unixTimestamp32", typespecScalar: "unixTimestamp32", category: "Date & Time", description: "32-bit Unix timestamp (seconds since epoch)", example: "1714992000" },

  // Structured category
  { id: "enum", label: "enum", typespecScalar: "enum", category: "Structured", description: "Enumeration of named values", example: "A | B | C" },
  { id: "array", label: "array", typespecScalar: "array", category: "Structured", description: "Ordered list of elements", example: "[1, 2, 3]" },
  { id: "map", label: "map", typespecScalar: "Record", category: "Structured", description: "Key-value mapping", example: '{"k": "v"}' },
  { id: "object", label: "object", typespecScalar: "model", category: "Structured", description: "Structured object with named properties", example: "{ ... }" },

  // Special category
  { id: "reference", label: "reference", typespecScalar: "reference", category: "Special", description: "Reference to another entity", example: "ref(Entity)" },
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
