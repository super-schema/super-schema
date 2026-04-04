export interface TypeSuggestion {
  type: string;
  isKey?: boolean;
}

const NAME_TO_TYPE: [RegExp, TypeSuggestion][] = [
  // ID patterns — suggest string + isKey
  [/(_id|^id|^uuid|^guid)$/i, { type: "string", isKey: true }],

  // Money/decimal patterns
  [/^(amount|balance|price|cost|total|rate|fee|tax|salary|revenue|income)$/i, { type: "decimal" }],

  // Integer patterns
  [/^(count|quantity|num_|number_of|age|year|month|day|order|rank|level|score|size|length|width|height|position)$/i, { type: "integer" }],

  // Boolean prefix patterns
  [/^(is_|has_|can_|should_|allow|enable)/i, { type: "boolean" }],

  // Temporal patterns
  [/(created_at|updated_at|deleted_at|timestamp|date_time|datetime|_at$)/i, { type: "utcDateTime" }],
  [/(birth_date|start_date|end_date|expiry_date|_date$|^date_)/i, { type: "plainDate" }],
  [/(start_time|end_time|_time$)/i, { type: "plainTime" }],

  // Enum patterns
  [/^(status|type|category|role|gender|priority|severity|state|level)$/i, { type: "enum" }],

  // String patterns — explicit names
  [/^(email|url|uri|phone|mobile|address|name|first_name|last_name|full_name|description|title|label|slug|path|city|state|country|zip|postal|content|body|text|bio|summary)$/i, { type: "string" }],

  // Object patterns
  [/^(data|payload|config|settings|options|metadata|properties|attributes)$/i, { type: "object" }],

  // Bytes patterns
  [/^(image|photo|avatar|logo|icon|file|attachment|document)$/i, { type: "bytes" }],
];

export function suggestType(fieldName: string): TypeSuggestion | null {
  const normalized = fieldName.toLowerCase().trim();
  if (!normalized) return null;

  for (const [pattern, suggestion] of NAME_TO_TYPE) {
    if (pattern.test(normalized)) {
      return suggestion;
    }
  }
  return null;
}
