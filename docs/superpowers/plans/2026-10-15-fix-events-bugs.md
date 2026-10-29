# Fix Events/AsyncAPI Subsystem — 3 Verified Bugs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three verified issues in the events/AsyncAPI subsystem: tenant isolation in message publish trait lookup, incorrect `decodeURIComponent` on JSON Pointer segments, and confusing diagnostic when reply messages lack a reply channel.

**Architecture:** Three independent, single-file fixes with targeted tests. No API surface changes. Each fix touches one source file + one test file. No migration, no schema change, no new dependencies.

**Tech Stack:** TypeScript, Vitest, Prisma

**Spec:** Code review findings documented in this conversation

## Global Constraints

- All services return `Result<T, ServiceError>` — never throw
- Tenant isolation: queries MUST scope by `tenantId` (spec §10)
- JSON Pointer: follow RFC 6901 (no percent-encoding)
- Diagnostic messages must name the failing item clearly

## Review Focus

1. A message with a trait from another tenant: the publish preview must NOT show the foreign trait's name. Current code omits the `tenantId` filter on the trait query and would leak it.
2. A JSON Pointer segment containing `%20` (literal percent-two-zero) must survive `parseLocalRef` as `%20`, not ` ` (space). Current code applies `decodeURIComponent` and corrupts it.
3. A draft event spec with reply messages but no reply channel: `planArtifacts` must NOT silently skip rendering those messages. The assembler's `REPLY_CHANNEL_REQUIRED` diagnostic is correct, but the artifact planner silently omitting formats causes confusing downstream failures.

---

### Task 1: Fix trait query tenant isolation in message publish state loader

**Files:**
- Modify: `src/services/events/message-publish.service.ts:52`
- Modify: `tests/unit/services/events/message-publish.service.test.ts`

**Interfaces:**
- Consumes: `row.tenantId` (already selected at line 33)
- Produces: same interface — `loadMessagePublishState` return type unchanged

- [ ] **Step 1: Add the tenantId to the trait query in `loadMessagePublishState`**

In `src/services/events/message-publish.service.ts`, line 48-52, change:

```typescript
  const traitIds = [...new Set([...spec.traitIds, ...(latestResolved?.spec.traitIds ?? [])])];
  const [entities, versions, traits] = await Promise.all([
    db.entity.findMany({ where: { id: { in: used.map((r) => r[1]) } }, select: { id: true, name: true, latestVersion: { select: { major: true, minor: true } } } }),
    db.entityVersion.findMany({ where: { id: { in: used.map((r) => r[2]).filter(isString) } }, select: { id: true, entityId: true, major: true, minor: true } }),
    traitIds.length > 0 ? db.trait.findMany({ where: { id: { in: traitIds } }, select: { id: true, name: true, kind: true } }) : Promise.resolve([]),
  ]);
```

To:

```typescript
  const traitIds = [...new Set([...spec.traitIds, ...(latestResolved?.spec.traitIds ?? [])])];
  const [entities, versions, traits] = await Promise.all([
    db.entity.findMany({ where: { id: { in: used.map((r) => r[1]) } }, select: { id: true, name: true, latestVersion: { select: { major: true, minor: true } } } }),
    db.entityVersion.findMany({ where: { id: { in: used.map((r) => r[2]).filter(isString) } }, select: { id: true, entityId: true, major: true, minor: true } }),
    traitIds.length > 0
      ? db.trait.findMany({ where: { id: { in: traitIds }, tenantId: row.tenantId }, select: { id: true, name: true, kind: true } })
      : Promise.resolve([]),
  ]);
```

- [ ] **Step 2: Add a test that a foreign-tenant trait is treated as missing in publish state**

In `tests/unit/services/events/message-publish.service.test.ts`, add this test case inside the existing `describe("publishMessage (unit)")` block, after the last ownership test (after line 159):

```typescript
  it("does not resolve a trait from another tenant even when the id matches — the publish state lists it as missing", async () => {
    const row = { ...MESSAGE_ROW, spec: { traitIds: ["t-foreign"] }, tenantId: "t1" };
    const db = makeDb([row]);
    // The trait findMany now receives { id: { in: ["t-foreign"] }, tenantId: "t1" } and returns nothing
    db.trait.findMany.mockImplementation(async (args: { where: { id: { in: string[] }; tenantId?: string } }) => {
      // tenantId filter is present and the foreign trait's tenant differs
      expect(args.where.tenantId).toBe("t1");
      return [];
    });
    const preview = await previewMessagePublish("m1", OWNING_PRODUCT, ctxOf(db));
    expect(preview.success).toBe(true);
    if (!preview.success) return;
    // The foreign trait is a blocker, not silently resolved
    expect(preview.data.blockers.some((b) => b.kind === "MISSING_TRAIT")).toBe(true);
    // No foreign trait name leaks into reasons or blockers
    const text = JSON.stringify(preview.data);
    expect(text).not.toMatch(/foreign-trait/i);
  });
```

- [ ] **Step 3: Run the test to verify it catches the old behavior**

Run: `npx vitest run tests/unit/services/events/message-publish.service.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: the `tenantId` assertion in the mock fails (old code doesn't pass `tenantId`), OR the trait is resolved when it shouldn't be (test fails).

- [ ] **Step 4: Apply the fix from Step 1 and re-run**

Run: `npx vitest run tests/unit/services/events/message-publish.service.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: ALL tests pass (both existing + new)

- [ ] **Step 5: Commit**

```bash
git add src/services/events/message-publish.service.ts tests/unit/services/events/message-publish.service.test.ts
git commit -m "fix(events): scope trait lookup to message's tenant in publish state loader

The trait query in loadMessagePublishState was missing a tenantId filter.
A trait id from another tenant would resolve and its name would leak into
the publish preview. Now filtered by row.tenantId, matching the pattern
in normalizeMessage (message.service.ts).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Remove incorrect `decodeURIComponent` from JSON Pointer parsing

**Files:**
- Modify: `src/lib/event-specs/json-pointer.ts:31-37`
- Modify: `tests/unit/lib/event-specs/json-pointer.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `parseLocalRef` return type unchanged — `string[] | null`

- [ ] **Step 1: Add failing tests for percent-encoded-looking segments**

In `tests/unit/lib/event-specs/json-pointer.test.ts`, add inside the `describe("json pointers")` block, after the existing `parseLocalRef` test (after line 17):

```typescript
  it("preserves percent-encoded-looking segments as literal text (RFC 6901 has no percent-encoding)", () => {
    // A schema property key that happens to contain %20
    expect(parseLocalRef("#/definitions/my%20field")).toEqual(["definitions", "my%20field"]);
    // A channel key with %XX patterns
    expect(parseLocalRef("#/channels/a%2Fb/messages/X")).toEqual(["channels", "a%2Fb", "messages", "X"]);
    // Mixed: real ~1 escape + percent-looking substring
    expect(parseLocalRef("#/path/a~1b%20c")).toEqual(["path", "a/b%20c"]);
  });

  it("decodeURIComponent is NOT applied — %XX stays literal", () => {
    // Verify that resolveLocalRef can find a key with literal %20
    const doc = { "my key": { "has%20space": true } };
    expect(resolveLocalRef(doc, "#/my key/has%20space")).toEqual({ found: true, value: true });
  });
```

- [ ] **Step 2: Run to verify test FAILS on current code**

Run: `npx vitest run tests/unit/lib/event-specs/json-pointer.test.ts --reporter=verbose 2>&1 | tail -30`
Expected: the "preserves percent-encoded-looking segments" test FAILS — `my%20field` becomes `my field`, `a%2Fb` becomes `a/b`.

- [ ] **Step 3: Remove `decodeURIComponent` from `parseLocalRef`**

In `src/lib/event-specs/json-pointer.ts`, lines 31-37, change:

```typescript
    .map((raw) => {
      let decoded = raw;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        // keep the raw segment when it is not valid percent-encoding
      }
      return unescapePointerSegment(decoded);
    });
```

To:

```typescript
    .map((raw) => unescapePointerSegment(raw));
```

The function `unescapePointerSegment` already handles RFC 6901 escapes (`~1` → `/`, `~0` → `~`). No other transformation is needed.

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx vitest run tests/unit/lib/event-specs/json-pointer.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: ALL tests PASS (existing + 2 new)

- [ ] **Step 5: Run the full test suite to catch any downstream breakage**

Run: `npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: all tests pass. The `decodeURIComponent` removal could only affect code that depended on its behavior — but since RFC 6901 never uses percent-encoding, no correct code should have depended on it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/event-specs/json-pointer.ts tests/unit/lib/event-specs/json-pointer.test.ts
git commit -m "fix(event-specs): remove incorrect decodeURIComponent from JSON Pointer parsing

RFC 6901 uses ~0 and ~1 for escaping, never percent-encoding. The
decodeURIComponent call was corrupting valid pointer segments that
happen to contain %XX substrings (e.g. a property key 'my%20field'
became 'my field', breaking reference resolution).

Only unescapePointerSegment is needed for RFC 6901 compliance.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Fix `planArtifacts` to handle reply messages without a reply channel

**Files:**
- Modify: `src/lib/events/catalog-mapping.ts:192-195`
- Modify: `tests/unit/lib/events/catalog-mapping.test.ts`

**Interfaces:**
- Consumes: `doc.operations[].reply?.channelId`, `doc.operations[].reply?.messageVersionIds`
- Produces: `planArtifacts` return type unchanged — `Map<string, { payloadFormats: PayloadFormat[]; keyFormats: PayloadFormat[] }>`

- [ ] **Step 1: Understand the current behavior**

The `add` helper at line 182-190 silently returns when `channelId` is undefined or the channel is not found. Reply messages without a reply channel have no formats planned. The assembler later reports `REPLY_CHANNEL_REQUIRED`, but the renderer can't render artifacts in the right format for those messages. The fix: when a reply has messages but no channel, fall back to the operation's own channel for format planning. Reply messages go on the reply channel, but their payload format is the same as the operation's channel.

- [ ] **Step 2: Add a failing test**

In `tests/unit/lib/events/catalog-mapping.test.ts`, add this test case:

```typescript
  it("plans artifact formats for reply messages even when they lack a dedicated reply channel (fallback to op channel)", () => {
    const channels = new Map([["ch1", { id: "ch1", profile: { format: "avro" as const } } as ResolvedChannel]]);
    const doc: EventSpecDocument = {
      info: { title: "t" },
      servers: [],
      operations: [
        {
          key: "op1",
          action: "receive",
          channelId: "ch1",
          messageVersionIds: ["mv1"],
          traitIds: [],
          reply: { messageVersionIds: ["mv2"] }, // reply messages, NO reply channel
        },
      ],
    };
    const needs = planArtifacts(doc, channels);
    // mv2 should get its format from the operation's own channel as fallback
    expect(needs.get("mv2")).toEqual({ payloadFormats: ["avro"], keyFormats: [] });
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/lib/events/catalog-mapping.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL — `needs.get("mv2")` is `undefined` (reply messages with no reply channel are silently skipped).

- [ ] **Step 4: Apply the fix**

In `src/lib/events/catalog-mapping.ts`, lines 192-195, change:

```typescript
  for (const op of doc.operations) {
    add(op.channelId, op.messageVersionIds);
    add(op.reply?.channelId, op.reply?.messageVersionIds); // reply messages need a reply channel (assembler rule)
  }
```

To:

```typescript
  for (const op of doc.operations) {
    add(op.channelId, op.messageVersionIds);
    // Reply messages without their own reply channel inherit the operation's
    // channel for format planning. The assembler still flags REPLY_CHANNEL_REQUIRED,
    // but at least the renderer has the right formats to produce coherent diagnostics.
    add(op.reply?.channelId ?? op.channelId, op.reply?.messageVersionIds);
  }
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run tests/unit/lib/events/catalog-mapping.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: ALL tests PASS (existing + new)

- [ ] **Step 6: Run the assembly and resolver tests to verify no downstream breakage**

```bash
npx vitest run tests/unit/lib/event-specs/assemble.test.ts tests/unit/services/events/event-spec-resolver.test.ts --reporter=verbose 2>&1 | tail -20
```
Expected: all pass. The change only adds entries to the `needs` map, never removes them. The assembler already handles reply messages without a reply channel via `REPLY_CHANNEL_REQUIRED`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/events/catalog-mapping.ts tests/unit/lib/events/catalog-mapping.test.ts
git commit -m "fix(events): plan artifacts for reply messages without a reply channel

When an operation has reply messages but no reply channel, planArtifacts
was silently skipping them (add() no-ops when channelId is undefined).
Now falls back to the operation's own channel for format planning, so the
renderer produces artifacts in the right format. The assembler still
reports REPLY_CHANNEL_REQUIRED — this just prevents confusing downstream
'no artifact' errors.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---