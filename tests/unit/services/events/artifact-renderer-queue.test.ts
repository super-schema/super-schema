// @vitest-environment node
/**
 * The event renderer's own queue is bounded like the compiler's (src/services/events/artifact-renderer.ts): a render beyond the waiting line, or one
 * that waited longer than its maximum, is answered `EMITTER_BUSY` and starts nothing; a queued draft render whose caller went away leaves the line and
 * starts nothing. Each of the three was unbounded before: the renderer waited for its turn without a limit and an abort did not remove the render.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ prisma: {} }));
// A draft has no reference to resolve here: the render is about its queue, not the closure of a draft.
vi.mock("@/lib/entity-versioning/line-references", () => ({ resolveEntityReferences: async () => ({ targetIds: [], unresolvedNames: [] }) }));
import { createArtifactRenderer, type EmitFiles } from "@/services/events/artifact-renderer";

const SOURCE = (name: string) => `model ${name} {\n  id: string;\n}\n`;
const version = (name: string) => ({ kind: "version" as const, entityVersionId: name, tenantId: "t1" });

/** Every version is a root model of its own name, with no pins; the draft is a model `Draft`. */
function fakeDb() {
  const entity = { id: "d1", name: "Draft", typespecSource: SOURCE("Draft"), metadata: {}, tenantId: "t1", domainId: "dom", productId: "p1", fields: [], tenant: { slug: "acme" }, domain: { slug: "payments" }, product: { slug: "checkout" } };
  return {
    entityVersion: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id, entityId: `e-${where.id}`, major: 1, minor: 0, resolvedSource: SOURCE(where.id), fieldSnapshot: [], entity: { name: where.id, tenantId: "t1" },
      })),
    },
    schemaReference: { findMany: vi.fn(async () => []) },
    entity: { findUnique: vi.fn(async () => entity) },
  };
}

/** An emitter that holds every run until `release` is called, then writes the root model's Avro file. */
function blockingEmitter() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const emitFiles = vi.fn<EmitFiles>(async (_packageName, source) => {
    await gate;
    const root = /model (\w+) \{/.exec(source)?.[1] ?? "Root";
    return { success: true, data: [{ relativePath: `${root}.avsc.json`, content: JSON.stringify({ type: "record", name: root, fields: [] }) }] };
  });
  return { emitFiles, release };
}

/** Lets a render that has just been started reach the queue (its database reads are in-memory, so a few turns are enough). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the event renderer's queue", () => {
  it("answers a render beyond the waiting line EMITTER_BUSY at once, and starts nothing for it", async () => {
    const { emitFiles, release } = blockingEmitter();
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 1, maxWaiting: 1 });

    const running = renderer.render(version("Alpha"), "avro");
    await vi.waitFor(() => expect(emitFiles).toHaveBeenCalledTimes(1));
    const waiting = renderer.render(version("Beta"), "avro");
    await settle();
    const refused = await renderer.render(version("Gamma"), "avro");

    expect(refused).toMatchObject({ success: false, error: { code: "EMITTER_BUSY" } });
    release();
    expect((await running).success).toBe(true);
    expect((await waiting).success).toBe(true);
    expect(emitFiles).toHaveBeenCalledTimes(2);
  });

  it("answers a render that waited longer than its maximum EMITTER_BUSY, and never starts it", async () => {
    const { emitFiles, release } = blockingEmitter();
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 1, maxWaitMs: 20 });

    const running = renderer.render(version("Alpha"), "avro");
    await vi.waitFor(() => expect(emitFiles).toHaveBeenCalledTimes(1));
    const waited = await renderer.render(version("Beta"), "avro");

    expect(waited).toMatchObject({ success: false, error: { code: "EMITTER_BUSY" } });
    release();
    expect((await running).success).toBe(true);
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });

  it("drops a queued draft render whose caller went away: it leaves the line and starts nothing", async () => {
    const { emitFiles, release } = blockingEmitter();
    const renderer = createArtifactRenderer({ db: fakeDb() as never, emitFiles, concurrency: 1 });

    const running = renderer.render(version("Alpha"), "avro");
    await vi.waitFor(() => expect(emitFiles).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const draft = renderer.render({ kind: "draft", entityId: "d1", tenantId: "t1" }, "avro", undefined, { signal: controller.signal });
    await settle();
    controller.abort();

    const cancelled = await draft;
    expect(cancelled).toMatchObject({ success: false, error: { details: { cause: "EMITTER_CANCELLED" } } });
    release();
    expect((await running).success).toBe(true);
    expect(emitFiles).toHaveBeenCalledTimes(1);
  });
});
