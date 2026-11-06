# API operations on entities, built on OpenAPI + TypeSpec

Contract: `src/types/schemas/api-operation.ts` (zod; single source of truth). Reuse libs, do not hand-roll:
`@scalar/openapi-parser` (+ upgrader, promote to real dep), `openapi-types`, `@typespec/http` + `@typespec/openapi3`
(existing emitter), `openapi-sampler`, `react-hook-form` + zod resolver, `@scalar/api-reference-react` (lazy preview).

Done already: ApiTab setState-in-render fix (edit()/debounced persist).

## Phases
A. Data + actions: prisma migration (Operation: operationId, summary, tags Json, deprecated, requestBody Json?; params: isArray, location adds cookie; responses: isArray, contentType), actions accept/return contract shape, zod + @scalar/openapi-parser validation (dup method+path, path params match, valid names), unit tests. Files: prisma/, src/app/(dashboard)/schemas/[domainSlug]/actions.ts, src/lib/api-operations/**.
B. Emission (parallel w/ A): DB operations -> SuperSchemaInterface/TypeSpec (@route/@get.../@body/@query/@path/@statusCode/@tag/#deprecated), wire into openapi3 target, lift closure restriction for entity-scoped ops, tests validating output via @scalar/openapi-parser. Files: src/lib/compiler/typespec-generator.ts, src/lib/typespec-official/**, src/lib/api-operations/to-typespec.ts.
C. UI (after A): rebuild ApiTab on react-hook-form+zod; request body, typed responses (entity picker, array), full status list, tags/operationId/deprecated, param type picker, path-param sync, "Generate CRUD", duplicate/reorder, saving indicator, service settings (name/basePath), tenant-level entity message. Files: ApiTab.tsx + new components in same dir.
D. Import + preview (after A,B): "Import OpenAPI" (parse/upgrade/validate -> operations), lazy Scalar preview tab of emitted openapi3. Files: src/lib/api-operations/import-openapi.ts, ApiPreview component, ImportDialog hook-in.
E. Tests + verify: unit, component, e2e (tests/e2e), tsc, lint, full unit suite.
