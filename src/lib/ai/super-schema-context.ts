/** Common modeling rules for AI-assisted schema authoring; each operation supplies its own output contract. */
export const SUPER_SCHEMA_MODELING_CONTEXT = `## Super Schema modeling context
- Entities define reusable business data: typed fields, descriptions and governance/classification. An entity is independent of its transport or serialization format.
- Events are AsyncAPI 3.0 specifications describing messages, channels, operations and protocol bindings. A message's business payload references an entity and its selected version; an event specification is not itself a payload entity.
- New event messages use reusable CloudEvents message traits by default. Keep CloudEvents envelope metadata separate from business payload fields unless the business data explicitly requires those same fields.
- Shared entities and custom data types describe common structures reused by multiple schemas. Consider existing domain entities before proposing duplicate business structures.
- Never invent existing entity identifiers or version pins, and never claim that related entities, types or events have been created. The current operation's output contract determines which suggestions it can return.`;
