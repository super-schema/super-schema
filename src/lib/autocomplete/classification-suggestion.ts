const NAME_TO_CLASSIFICATION: [RegExp, string][] = [
  // PII
  [/(email|phone|mobile|fax|ssn|social_security|passport|driver_license|birth_date|date_of_birth|address|zip|postal|first_name|last_name|full_name)$/i, "PII"],
  [/^(name|phone|email|ssn|dob|address)$/i, "PII"],

  // SENSITIVE
  [/(password|secret|token|api_key|private_key|credit_card|card_number|cvv|pin|account_number|routing_number|salary|income|balance|amount)$/i, "SENSITIVE"],
  [/^(password|secret|token|key|credential)$/i, "SENSITIVE"],

  // INTERNAL
  [/(internal_id|tenant_id|org_id|company_id|department|team|role|permission|audit|log|trace)$/i, "INTERNAL"],
  [/^(id|uuid|created_at|updated_at|deleted_at|version|status|type|category)$/i, "INTERNAL"],

  // PUBLIC
  [/(product_name|product_title|sku|barcode|country|currency|language|timezone|description|title|label|slug|url)$/i, "PUBLIC"],
];

export function suggestClassification(fieldName: string): string | null {
  const normalized = fieldName.toLowerCase().trim();
  if (!normalized) return null;

  for (const [pattern, classification] of NAME_TO_CLASSIFICATION) {
    if (pattern.test(normalized)) {
      return classification;
    }
  }
  return null;
}
