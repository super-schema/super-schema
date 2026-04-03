const NAME_TO_TYPE: [RegExp, string][] = [
  [/^(amount|balance|price|cost|total|rate|fee|tax|salary|revenue)$/i, "decimal"],
  [/^(count|quantity|num_|number_of|age|year|month|day|order|rank|level|score|size|length|width|height)$/i, "integer"],
  [/(email|mail)$/i, "string"],
  [/(phone|mobile|fax|tel)$/i, "string"],
  [/^(id|uuid|guid)$/i, "uuid"],
  [/^(is_|has_|can_|should_|allow|enable|active|visible|deleted|archived|verified|confirmed)/i, "boolean"],
  [/(created_at|updated_at|deleted_at|timestamp|date_time|datetime|_at$)/i, "timestamp"],
  [/(birth_date|start_date|end_date|expiry_date|_date$|^date_)/i, "date"],
  [/(start_time|end_time|_time$)/i, "time"],
  [/^(name|title|label|description|note|comment|message|address|city|state|country|zip|postal|url|path|slug)$/i, "string"],
  [/^(status|type|category|role|gender|priority|severity|level)$/i, "enum"],
  [/^(data|payload|config|settings|options|metadata|properties|attributes)$/i, "json"],
  [/^(content|body|text|bio|summary|abstract|details)$/i, "text"],
  [/^(image|photo|avatar|logo|icon|file|attachment|document)$/i, "binary"],
];

export function suggestType(fieldName: string): string | null {
  const normalized = fieldName.toLowerCase().trim();
  if (!normalized) return null;

  for (const [pattern, type] of NAME_TO_TYPE) {
    if (pattern.test(normalized)) {
      return type;
    }
  }
  return null;
}
