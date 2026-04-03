const COMMON_FIELDS = [
  "id", "uuid", "name", "title", "description", "status", "type", "category",
  "email", "phone", "address", "city", "state", "country", "zip_code",
  "first_name", "last_name", "full_name", "date_of_birth",
  "created_at", "updated_at", "deleted_at",
  "is_active", "is_deleted", "is_verified",
  "amount", "price", "quantity", "total", "balance",
  "currency", "language", "timezone",
  "url", "slug", "image_url", "avatar_url",
  "version", "sort_order", "priority",
  "notes", "comments", "metadata",
  "start_date", "end_date", "expiry_date",
  "owner_id", "created_by", "updated_by",
  "parent_id", "tenant_id", "org_id",
];

export interface AutocompleteSuggestion {
  value: string;
  source: "common" | "domain" | "pattern";
}

export function getFieldNameSuggestions(
  query: string,
  existingFieldNames: string[] = [],
  maxResults = 8
): AutocompleteSuggestion[] {
  if (!query || query.length < 2) return [];

  const q = query.toLowerCase();
  const existing = new Set(existingFieldNames.map((n) => n.toLowerCase()));

  const suggestions: AutocompleteSuggestion[] = [];

  // Common field names
  for (const name of COMMON_FIELDS) {
    if (name.includes(q) && !existing.has(name)) {
      suggestions.push({ value: name, source: "common" });
    }
    if (suggestions.length >= maxResults) break;
  }

  return suggestions.slice(0, maxResults);
}
