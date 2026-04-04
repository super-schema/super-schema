export interface ClassificationSuggestion {
  level: string;
  reason: string;
}

const NAME_TO_CLASSIFICATION: [RegExp, ClassificationSuggestion][] = [
  // PII
  [/^(email|phone|mobile|fax|ssn|social_security|passport|driver_license|address|first_name|last_name|full_name|date_of_birth|name)$/i,
    { level: "PII", reason: "Field name indicates personally identifiable information" }],
  [/(email|phone|ssn|passport|birth_date|date_of_birth)$/i,
    { level: "PII", reason: "Field name pattern suggests PII data" }],

  // SENSITIVE — security credentials
  [/^(password|secret|token|api_key|credential|private_key)$/i,
    { level: "SENSITIVE", reason: "Field name indicates security credentials" }],
  [/(password|secret|token|api_key|private_key|credential)$/i,
    { level: "SENSITIVE", reason: "Field name pattern suggests sensitive credentials" }],

  // SENSITIVE — financial
  [/^(amount|balance|salary|income|credit_card|card_number|account_number|routing_number|cvv|pin)$/i,
    { level: "SENSITIVE", reason: "Field name indicates financial data" }],
];

export function suggestClassification(fieldName: string): ClassificationSuggestion | null {
  const normalized = fieldName.toLowerCase().trim();
  if (!normalized) return null;

  for (const [pattern, suggestion] of NAME_TO_CLASSIFICATION) {
    if (pattern.test(normalized)) {
      return suggestion;
    }
  }
  return null;
}
