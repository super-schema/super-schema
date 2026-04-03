export interface DataType {
  id: string;
  label: string;
  typespecScalar: string;
  category: string;
  parent?: string;
  description: string;
  requiresPrecision?: boolean;
  requiresScale?: boolean;
}

export const DATA_TYPE_HIERARCHY: DataType[] = [
  // Number category
  { id: "numeric", label: "Number", typespecScalar: "numeric", category: "Number", description: "Any numeric value" },
  { id: "integer", label: "Integer", typespecScalar: "integer", category: "Number", parent: "numeric", description: "Whole number (arbitrary precision)" },
  { id: "int8", label: "int8", typespecScalar: "int8", category: "Number", parent: "integer", description: "8-bit signed integer (-128 to 127)" },
  { id: "int16", label: "int16", typespecScalar: "int16", category: "Number", parent: "integer", description: "16-bit signed integer (-32768 to 32767)" },
  { id: "int32", label: "int32", typespecScalar: "int32", category: "Number", parent: "integer", description: "32-bit signed integer" },
  { id: "int64", label: "int64", typespecScalar: "int64", category: "Number", parent: "integer", description: "64-bit signed integer" },
  { id: "safeint", label: "safeint", typespecScalar: "safeint", category: "Number", parent: "integer", description: "Safe integer (JS Number.MAX_SAFE_INTEGER)" },
  { id: "uint8", label: "uint8", typespecScalar: "uint8", category: "Number", parent: "integer", description: "8-bit unsigned integer (0 to 255)" },
  { id: "uint16", label: "uint16", typespecScalar: "uint16", category: "Number", parent: "integer", description: "16-bit unsigned integer (0 to 65535)" },
  { id: "uint32", label: "uint32", typespecScalar: "uint32", category: "Number", parent: "integer", description: "32-bit unsigned integer" },
  { id: "uint64", label: "uint64", typespecScalar: "uint64", category: "Number", parent: "integer", description: "64-bit unsigned integer" },
  { id: "float", label: "Float", typespecScalar: "float", category: "Number", parent: "numeric", description: "Floating-point number" },
  { id: "float32", label: "float32", typespecScalar: "float32", category: "Number", parent: "float", description: "32-bit IEEE 754 floating-point" },
  { id: "float64", label: "float64", typespecScalar: "float64", category: "Number", parent: "float", description: "64-bit IEEE 754 floating-point" },
  { id: "decimal", label: "Decimal", typespecScalar: "decimal", category: "Number", parent: "numeric", description: "Exact decimal number", requiresPrecision: true, requiresScale: true },
  { id: "decimal128", label: "decimal128", typespecScalar: "decimal128", category: "Number", parent: "decimal", description: "128-bit decimal floating-point", requiresPrecision: true, requiresScale: true },

  // String category
  { id: "string", label: "String", typespecScalar: "string", category: "String", description: "Unicode text value" },
  { id: "url", label: "url", typespecScalar: "url", category: "String", parent: "string", description: "URL string" },

  // Boolean category
  { id: "boolean", label: "Boolean", typespecScalar: "boolean", category: "Boolean", description: "True or false value" },

  // Bytes category
  { id: "bytes", label: "Bytes", typespecScalar: "bytes", category: "Bytes", description: "Binary data" },

  // Date & Time category
  { id: "plainDate", label: "plainDate", typespecScalar: "plainDate", category: "Date & Time", description: "Date without time or timezone (YYYY-MM-DD)" },
  { id: "plainTime", label: "plainTime", typespecScalar: "plainTime", category: "Date & Time", description: "Time without date or timezone (HH:mm:ss)" },
  { id: "utcDateTime", label: "utcDateTime", typespecScalar: "utcDateTime", category: "Date & Time", description: "Date and time in UTC" },
  { id: "offsetDateTime", label: "offsetDateTime", typespecScalar: "offsetDateTime", category: "Date & Time", description: "Date and time with UTC offset" },
  { id: "duration", label: "duration", typespecScalar: "duration", category: "Date & Time", description: "ISO 8601 duration" },
  { id: "unixTimestamp32", label: "unixTimestamp32", typespecScalar: "unixTimestamp32", category: "Date & Time", description: "32-bit Unix timestamp (seconds since epoch)" },

  // Structured category
  { id: "enum", label: "enum", typespecScalar: "enum", category: "Structured", description: "Enumeration of named values" },
  { id: "array", label: "array", typespecScalar: "array", category: "Structured", description: "Ordered list of elements" },
  { id: "map", label: "map", typespecScalar: "Record", category: "Structured", description: "Key-value mapping" },
  { id: "object", label: "object", typespecScalar: "model", category: "Structured", description: "Structured object with named properties" },

  // Special category
  { id: "reference", label: "reference", typespecScalar: "reference", category: "Special", description: "Reference to another entity" },
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
