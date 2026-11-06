# Field completeness checks

Configure checks under **Admin → Domains → Configure policy → Field completeness checks**.
Select a data type and choose **Off**, **Suggested**, or **Required** for each check.
**Default** restores the built-in or inherited setting. **All field types** configures common metadata checks.

Defaults:

| Data type | Check | Level |
| --- | --- | --- |
| string and string subtypes | Minimum and maximum length | Suggested |
| decimal and decimal128 | Precision and scale | Required |
| every field | Name and data type | Structural requirement |

Default Class 3 is valid and creates no completeness suggestion. Floating-point types have their own precision; decimal precision/scale checks do not apply to them.
Optional checks include field description, a string validation pattern, and numeric bounds.
Zero is a valid minimum length, numeric bound, or decimal scale. Missing, malformed, or negative length constraints do not satisfy a check.

The indicator is green when all enabled checks pass and yellow otherwise. Its tooltip lists **Required** and **Suggested** items separately.
Field cards, completeness filters/counts, and Field Studio use the same evaluator and domain policy.
These are authoring-readiness checks; existing domain Alerts and compiler/publish validation retain their own rules.

## Stored policy

Overrides are stored in the domain's existing `policyTemplate.fieldCompleteness` JSON. No database migration is needed.
Saving a policy revalidates schema workspaces; the updated checks are used when a workspace next loads its domain policy.

```json
{
  "fieldCompleteness": {
    "*": { "description": "suggested" },
    "string": { "minLength": "required", "maxLength": "suggested" },
    "url": { "maxLength": "off" },
    "decimal": { "precision": "required", "scale": "required" }
  }
}
```

Resolution order is built-in defaults, common (`*`) overrides, then parent-to-child type overrides.
For example, `decimal128` inherits `decimal` checks, and `url` inherits `string` checks.
Explicit `off` overrides an inherited requirement. Checks only apply to their supported type families.

## Adding a check

1. Add a stable ID to `FIELD_COMPLETENESS_RULE_IDS` in `src/types/schemas/field-completeness-policy.ts`.
2. Register its label, supported type families, and predicate in `FIELD_COMPLETENESS_RULES` in `src/lib/validation/field-completeness.ts`.
3. Choose any built-in defaults in `DEFAULT_FIELD_COMPLETENESS_POLICY` and add evaluator tests.

The policy editor and tooltip pick up registered checks automatically. Policy schemas validate IDs and levels before persistence.
Domain policy saves use `updateDomainPolicyAction`, which delegates domain and tenant authorization to `updateDomainAdmin`.
