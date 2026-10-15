import { describe, it, expect, vi, afterEach } from "vitest";
import { toResolvedChannel, messageSourceFromVersion, toFrozenTrait } from "@/lib/events/catalog-mapping";
import { resolveSnapshot, type DraftSnapshot } from "@/services/events/event-spec-resolver";
import type { ArtifactRenderer, ArtifactSubject } from "@/services/events/artifact-renderer";
import type { PayloadFormat } from "@/lib/event-specs/types";
import { err, ok } from "@/types/result";

const channel = toResolvedChannel({
  id: "c1", name: "orders", address: "payments.orders.v1", protocol: "kafka", format: "avro", formatDialect: null, spec: {}, product: { slug: "checkout" },
});
const message = messageSourceFromVersion({
  id: "mv1", messageId: "m1", major: 1, minor: 0,
  resolvedSpec: {
    name: "OrderCreated", spec: { traitIds: ["t1"] },
    payload: { entityId: "e1", entityName: "Order", entityVersionId: "ev-order", label: "1.0", major: 1 },
    headers: { entityId: "e3", entityName: "Headers", entityVersionId: "ev-headers", label: "1.0", major: 1 },
    key: { entityId: "e2", entityName: "OrderKey", entityVersionId: "ev-key", label: "1.0", major: 1 },
  },
  message: { name: "OrderCreated", product: { slug: "checkout" } },
});
const trait = toFrozenTrait({
  id: "t1", name: "CloudEvents", kind: "MESSAGE", spec: {}, headersEntityId: "e9", headersEntityVersionId: "ev-trait-headers",
  tenant: { slug: "acme" }, domain: null, product: null,
});

function snapshot(over: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    spec: {
      id: "s1", name: "checkout-service", specType: "asyncapi@3.0", tenantId: "t", domainId: "d", productId: "p", productSlug: "checkout",
      updatedAt: new Date(0), hasUnpublishedChanges: true, latestVersionId: null,
    },
    document: {
      info: { title: "checkout-service" }, servers: [],
      operations: [{ key: "publish", action: "send", channelId: "c1", messageVersionIds: ["mv1"], traitIds: [] }],
    },
    latest: null,
    channels: [channel],
    traits: [trait],
    messages: message ? [message] : [],
    messageVersionInfo: {},
    unresolved: [],
    ...over,
  };
}

const schemaFor = (subject: ArtifactSubject, format: PayloadFormat) => ({
  format,
  schema: format === "protobuf" ? "syntax = 'proto3';" : { type: format === "avro" ? "record" : "object", name: subject.kind === "version" ? subject.entityVersionId : subject.entityId },
});

describe("resolveSnapshot", () => {
  it("renders payload + Kafka key in the channel's format and headers / trait headers as JSON Schema, then resolves the spec", async () => {
    const render = vi.fn(async (subject: ArtifactSubject, format: PayloadFormat) => ok({ artifact: schemaFor(subject, format), warnings: [] }));
    const out = await resolveSnapshot(snapshot(), { render } as ArtifactRenderer, "draft");

    expect(out.diagnostics).toEqual([]);
    expect(render.mock.calls.map(([s, f]) => `${s.kind === "version" ? s.entityVersionId : s.entityId}:${f}`).sort()).toEqual([
      "ev-headers:json-schema", "ev-key:avro", "ev-order:avro", "ev-trait-headers:json-schema",
    ]);
    expect(out.resolved?.info).toEqual({ title: "checkout-service", version: "draft" });
    const resolvedMessage = out.resolved?.messages[0];
    expect(resolvedMessage?.payloads).toHaveLength(1);
    expect(resolvedMessage?.keys).toHaveLength(1);
    expect(resolvedMessage?.headers?.format).toBe("json-schema");
    expect(out.resolved?.traits[0].headers?.format).toBe("json-schema");
  });

  it("maps BOTH renderer failure shapes to error diagnostics (wrapped combine/emit errors with details.cause, and loader codes) and still resolves", async () => {
    const render: ArtifactRenderer["render"] = async (subject, format) => {
      const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
      if (id === "ev-order") {
        return err({
          code: "ARTIFACT_RENDER_FAILED", message: "Order@1.0 → avro: Unknown identifier Ghost", details: { cause: "TYPESPEC_DECLARATION_CONFLICT" },
          suggestedFix: "Pin the referenced entity.",
        });
      }
      if (id === "ev-key") return err({ code: "UNPUBLISHED_REFERENCE", message: 'Entity "Address" has no published version', details: { cause: "UNPUBLISHED_REFERENCE" } });
      if (id === "ev-headers") return err({ code: "NOT_FOUND", message: 'Entity version "ev-headers" not found' });
      return ok({ artifact: schemaFor(subject, format), warnings: ["Duplicate declaration of Address (first wins)"] });
    };
    const out = await resolveSnapshot(snapshot(), { render }, "draft");

    expect(out.resolved).not.toBeNull(); // the assembler reports the missing artifacts itself; the render causes are listed too
    expect(out.diagnostics).toHaveLength(4); // order follows async completion; emitEventSpec normalizes
    expect(out.diagnostics).toEqual(expect.arrayContaining([
      {
        severity: "error", code: "ARTIFACT_RENDER_FAILED", pointer: "",
        message: "Message OrderCreated payload (avro): Order@1.0 → avro: Unknown identifier Ghost [TYPESPEC_DECLARATION_CONFLICT] Fix: Pin the referenced entity.",
      },
      { severity: "error", code: "UNPUBLISHED_REFERENCE", pointer: "", message: 'Message OrderCreated key (avro): Entity "Address" has no published version' },
      { severity: "error", code: "NOT_FOUND", pointer: "", message: 'Message OrderCreated headers (json-schema): Entity version "ev-headers" not found' },
      { severity: "warning", code: "TYPESPEC_DUPLICATE_DECLARATION", pointer: "", message: "Trait CloudEvents headers: Duplicate declaration of Address (first wins)" },
    ]));
  });

  it("turns a renderer's coded notes (an Avro enum symbol that had to be renamed) into warnings carrying their own code", async () => {
    const note = { code: "AVRO_ENUM_SYMBOL_RENAMED", message: 'Avro enum symbol "in-progress" of Order_status is published as "in_progress"' };
    const render: ArtifactRenderer["render"] = async (subject, format) =>
      ok({ artifact: schemaFor(subject, format), warnings: [], ...(format === "avro" && subject.kind === "version" && subject.entityVersionId === "ev-order" ? { notes: [note] } : {}) });
    const out = await resolveSnapshot(snapshot(), { render }, "draft");
    expect(out.diagnostics).toEqual([
      { severity: "warning", code: "AVRO_ENUM_SYMBOL_RENAMED", pointer: "", message: `Message OrderCreated payload: ${note.message}` },
    ]);
  });

  describe("failures written by our own Avro / protobuf / enum guards are shown to the user, not replaced by the generic text", () => {
    const failing = (error: Parameters<typeof err>[0]): ArtifactRenderer["render"] => async (subject, format) => {
      const id = subject.kind === "version" ? subject.entityVersionId : subject.entityId;
      return id === "ev-order" ? err(error) : ok({ artifact: schemaFor(subject, format), warnings: [] });
    };
    const diagnosticsFor = async (error: Parameters<typeof err>[0]) => (await resolveSnapshot(snapshot(), { render: failing(error) }, "draft")).diagnostics;

    it("AVRO_SYMBOL_COLLISION names the enum and the colliding values", async () => {
      const diagnostics = await diagnosticsFor({
        code: "ARTIFACT_RENDER_FAILED",
        message: 'Order@1.0 → avro: Avro enum Order_status: the values "a-b" and "a b" would all be published as the symbol "a_b" — rename one of them',
        details: { cause: "AVRO_SYMBOL_COLLISION" },
      });
      expect(diagnostics).toEqual([
        {
          severity: "error",
          code: "ARTIFACT_RENDER_FAILED",
          pointer: "",
          message:
            'Message OrderCreated payload (avro): Order@1.0 → avro: Avro enum Order_status: the values "a-b" and "a b" would all be published as the symbol "a_b" — rename one of them [AVRO_SYMBOL_COLLISION]',
        },
      ]);
      expect(diagnostics[0].message).not.toContain("Artifact render failed");
    });

    it("AVRO_INVALID_SYMBOL (a numeric-valued enum member) names the enum and the symbol", async () => {
      const diagnostics = await diagnosticsFor({
        code: "AVRO_INVALID_SYMBOL",
        message: 'Avro enum Priority has the symbol "1", which is not valid (an Avro symbol must match [A-Za-z_][A-Za-z0-9_]*) — use named members without values',
      });
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ severity: "error", code: "AVRO_INVALID_SYMBOL" });
      expect(diagnostics[0].message).toContain('Avro enum Priority has the symbol "1"');
      expect(diagnostics[0].message).not.toContain("Artifact render failed");
    });

    it("ENUM_NO_VALUES names the entity version and the field, with the fix", async () => {
      const diagnostics = await diagnosticsFor({
        code: "ARTIFACT_RENDER_FAILED",
        message: 'Order (draft) → avro: enum field "status" has no values',
        suggestedFix: "Give the enum field at least one value.",
        details: { cause: "ENUM_NO_VALUES" },
      });
      expect(diagnostics[0].message).toBe(
        'Message OrderCreated payload (avro): Order (draft) → avro: enum field "status" has no values [ENUM_NO_VALUES] Fix: Give the enum field at least one value.'
      );
    });

    it("ROOT_MESSAGE_NOT_FOUND (a protobuf payload without its root message) is shown", async () => {
      const diagnostics = await diagnosticsFor({ code: "ROOT_MESSAGE_NOT_FOUND", message: 'Top-level message "Order" not found in .proto source' });
      expect(diagnostics).toEqual([
        { severity: "error", code: "ROOT_MESSAGE_NOT_FOUND", pointer: "", message: 'Message OrderCreated payload (avro): Top-level message "Order" not found in .proto source' },
      ]);
    });

    it("an unknown code is still replaced by the generic text (the allowlist is explicit)", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const diagnostics = await diagnosticsFor({ code: "SOMETHING_NEW", message: "raw detail from /var/folders/ab/superschema-tsp-x/main.tsp" });
      expect(diagnostics[0].message).toBe("Message OrderCreated payload (avro): Artifact render failed");
      spy.mockRestore();
    });
  });

  it("short-circuits on unresolved draft references without rendering anything", async () => {
    const render = vi.fn();
    const out = await resolveSnapshot(
      snapshot({ unresolved: [{ pointer: "/operations/0/channelId", message: 'Channel "gone" not found' }] }),
      { render } as unknown as ArtifactRenderer,
      "draft"
    );
    expect(render).not.toHaveBeenCalled();
    expect(out).toEqual({
      resolved: null,
      diagnostics: [{ severity: "error", code: "UNRESOLVED_REFERENCE", message: 'Draft reference: Channel "gone" not found', pointer: "/operations/0/channelId" }],
    });
  });

  it("does not render an unpinned key / headers (null subjects), and renders nothing for a message no operation references", async () => {
    const render = vi.fn(async (subject: ArtifactSubject, format: PayloadFormat) => ok({ artifact: schemaFor(subject, format), warnings: [] }));
    const bare = (id: string, entityVersionId: string) =>
      messageSourceFromVersion({
        id, messageId: `m-${id}`, major: 1, minor: 0,
        resolvedSpec: { name: `Msg-${id}`, spec: { traitIds: [] }, payload: { entityId: "e1", entityName: "Order", entityVersionId, label: "1.0", major: 1 }, headers: null, key: null },
        message: { name: `Msg-${id}`, product: { slug: "checkout" } },
      });
    const sources = [bare("mv1", "ev-order"), bare("mv-unused", "ev-unused")].flatMap((m) => (m ? [m] : []));
    expect(sources).toHaveLength(2);
    const out = await resolveSnapshot(snapshot({ messages: sources, traits: [] }), { render } as ArtifactRenderer, "draft");
    // only the referenced message's payload, in the channel's (Avro) format: no key / headers subjects, nothing for the unused message
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith({ kind: "version", entityVersionId: "ev-order" }, "avro");
    expect(out.resolved?.messages.map((m) => m.id)).toEqual(["mv1"]);
    expect(out.resolved?.messages[0].keys).toBeUndefined();
    expect(out.resolved?.messages[0].headers).toBeUndefined();
  });
});

describe("resolveSnapshot render-failure diagnostics never leak internals (R67)", () => {
  afterEach(() => vi.restoreAllMocks());

  const failingRender = (failure: ReturnType<typeof err>): ArtifactRenderer["render"] => async (subject, format) =>
    subject.kind === "version" && subject.entityVersionId === "ev-order" ? failure : ok({ artifact: schemaFor(subject, format), warnings: [] });
  const payloadDiagnostic = async (failure: ReturnType<typeof err>) => {
    const out = await resolveSnapshot(snapshot(), { render: failingRender(failure) }, "draft");
    return out.diagnostics.find((d) => d.message.startsWith("Message OrderCreated payload"));
  };

  it("replaces an unexpected throw (ARTIFACT_RENDER_FAILED without a cause) by a generic text and logs the original", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const raw = 'Entity version "ev-order" → avro: Invalid `prisma.entityVersion.findUnique()` invocation: Can\'t reach database server at `10.0.0.5:5432` (user "app", password "hunter2")';
    const d = await payloadDiagnostic(err({ code: "ARTIFACT_RENDER_FAILED", message: raw }));
    expect(d).toEqual({ severity: "error", code: "ARTIFACT_RENDER_FAILED", pointer: "", message: "Message OrderCreated payload (avro): Artifact render failed" });
    expect(JSON.stringify(d)).not.toMatch(/prisma|invocation|10\.0\.0\.5|hunter2|database/i);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ARTIFACT_RENDER_FAILED"), raw); // the original stays server-side
  });

  it("omits raw tsp stdout / stderr and temp paths of an emitter failure but keeps the code and the cause code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tsp = [
      "Order@1.0 → avro: /var/folders/zz/abc123/T/superschema-tsp-Xy12/main.tsp:14:5 - error unknown-identifier: Unknown identifier Ghost",
      "    at /Users/ci/app/node_modules/@typespec/compiler/dist/src/core/checker.js:100:3",
    ].join("\n");
    const d = await payloadDiagnostic(err({ code: "ARTIFACT_RENDER_FAILED", message: tsp, details: { cause: "EMITTER_FAILED" } }));
    expect(d).toEqual({ severity: "error", code: "ARTIFACT_RENDER_FAILED", pointer: "", message: "Message OrderCreated payload (avro): Artifact render failed [EMITTER_FAILED]" });
    expect(d?.message).not.toMatch(/var\/folders|superschema-tsp|main\.tsp|checker\.js|Users|Ghost/);
    expect(log).toHaveBeenCalled();
  });

  it("keeps the user-facing message of a timeout and of our own combiner errors, scrubbing any file path inside it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const timeout = await payloadDiagnostic(
      err({ code: "ARTIFACT_RENDER_FAILED", message: 'Order@1.0 → avro: Emitter "@typespec/avro" did not finish within 120000 ms and was killed.', details: { cause: "EMITTER_TIMEOUT" } })
    );
    expect(timeout?.message).toBe(
      'Message OrderCreated payload (avro): Order@1.0 → avro: Emitter "@typespec/avro" did not finish within 120000 ms and was killed. [EMITTER_TIMEOUT]'
    );
    const conflict = await payloadDiagnostic(
      err({ code: "TYPESPEC_DECLARATION_CONFLICT", message: "Address is declared twice (see /tmp/superschema-tsp-q1/a/main.tsp)", suggestedFix: "Rename one." })
    );
    expect(conflict?.message).toBe("Message OrderCreated payload (avro): Address is declared twice (see <path>) Fix: Rename one.");
    expect(log).not.toHaveBeenCalled(); // user-facing failures are not logged as unexpected
  });

  it("treats an unknown loader code like an unexpected failure (generic text, code kept)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const d = await payloadDiagnostic(err({ code: "DB_ERROR", message: "connect ECONNREFUSED 10.0.0.5:5432" }));
    expect(d).toEqual({ severity: "error", code: "DB_ERROR", pointer: "", message: "Message OrderCreated payload (avro): Artifact render failed" });
  });
});
