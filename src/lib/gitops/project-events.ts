import type { Prisma } from "@/generated/prisma/client";
import { Prisma as P } from "@/generated/prisma/client";
import { collectDocumentEdges } from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import {
  loadEventSnapshot,
  resolveEventSnapshot,
} from "@/services/events/event-snapshot";
import { createArtifactRenderer } from "@/services/events/artifact-renderer";
import { replaceReferences } from "@/services/events/schema-references";
import { emitResolved, withInternalKeys } from "@/services/events/event-emit.service";
import { compareVersion, stableVersionId } from "./canonical";
import { GitOpsError, type CanonicalDocument } from "./contracts";
const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
/** Reconstruct assembled event versions from canonical source, with event dependencies ordered before their consumers. */
export async function projectEventVersions(
  tx: Prisma.TransactionClient,
  documents: CanonicalDocument[],
  fallbackUserId: string,
) {
  const renderer = createArtifactRenderer({ db: tx });
  const events = documents.filter((d) => d.kind === "Event"),
    byId = new Map(
      events.map((d) => [
        String(d.spec.versionRecord?.id ?? stableVersionId(d)),
        d,
      ]),
    ),
    ordered: CanonicalDocument[] = [],
    active = new Set<string>(),
    done = new Set<string>();
  function visit(d: CanonicalDocument) {
    const id = String(d.spec.versionRecord?.id ?? stableVersionId(d));
    if (done.has(id)) return;
    if (active.has(id))
      throw new GitOpsError("Canonical event-version references form a cycle");
    active.add(id);
    const parsed = parseEventDocument(d.spec.record.document);
    if (!parsed.success)
      throw new GitOpsError("Invalid canonical event document");
    for (const edge of collectDocumentEdges(parsed.data))
      if (edge.toKind === "EVENT_SPEC_VERSION") {
        const dependency = byId.get(edge.toId);
        if (dependency) visit(dependency);
      }
    active.delete(id);
    done.add(id);
    ordered.push(d);
  }
  for (const event of events.toSorted((a, b) =>
    compareVersion(a.version!, b.version!),
  ))
    visit(event);
  for (const d of ordered) {
    const [major, minor, patch] = d
        .version!.replace(/_snapshot$/, "")
        .split(".")
        .map(Number),
      records = await tx.eventSpecVersion.findMany({
        where: { eventSpecId: d.id },
      }),
      old =
        records.find(
          (v) => v.major === major && v.minor === minor && v.patch === patch,
        ) ??
        (d.stage === "SNAPSHOT"
          ? records.find((v) => v.stage === "SNAPSHOT")
          : undefined);
    if (old?.stage === "RELEASED") continue;
    const stored = d.spec.versionRecord ?? {},
      id = old?.id ?? String(stored.id ?? stableVersionId(d));
    let document: unknown = stored.document,
      resolvedSpec: unknown = stored.resolvedSpec,
      frozenTraits: unknown = stored.frozenTraits ?? [];
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      typeof (document as Record<string, unknown>).asyncapi !== "string"
    ) {
      const parsed = parseEventDocument(d.spec.record.document);
      if (!parsed.success)
        throw new GitOpsError("Invalid canonical event document");
      const snapshot = await loadEventSnapshot(tx, d.id, parsed.data);
      if (!snapshot.success) throw new GitOpsError(snapshot.error.message);
      snapshot.data.event.name = String(d.spec.record.name);
      const resolved = await resolveEventSnapshot(
        snapshot.data,
        renderer,
        d.version!,
        () => true,
      );
      if (
        !resolved.resolved ||
        resolved.busy ||
        resolved.diagnostics.some((x) => x.severity === "error")
      )
        throw new GitOpsError(
          "The canonical event could not be resolved from its pinned source versions",
        );
      const output = await emitResolved(
        resolved.resolved,
        String(d.spec.record.specType ?? "asyncapi@3.0"),
        await withInternalKeys({}, snapshot.data.event.tenantId, tx),
      );
      if (
        !output.success ||
        output.data.diagnostics.some((x) => x.severity === "error")
      )
        throw new GitOpsError("The canonical event failed AsyncAPI validation");
      document = json(output.data.document);
      resolvedSpec = json(resolved.resolved);
      frozenTraits = json([...snapshot.data.libraryTraits.values()]);
    }
    const publishedById =
      typeof stored.publishedById === "string" &&
      (await tx.user.findUnique({ where: { id: stored.publishedById } }))
        ? stored.publishedById
        : fallbackUserId;
    const data = {
      eventSpecId: d.id,
      major,
      minor,
      patch,
      stage: d.stage!,
      sequence:
        old?.sequence ??
        (typeof stored.sequence === "number"
          ? stored.sequence
          : Math.max(0, ...records.map((v) => v.sequence)) + 1),
      document: json(document),
      sourceDocument: json(d.spec.record.document),
      resolvedSpec: resolvedSpec ? json(resolvedSpec) : P.DbNull,
      frozenTraits: json(frozenTraits),
      changeKind: (typeof stored.changeKind === "string"
        ? stored.changeKind
        : "INITIAL") as "INITIAL",
      compatReport: json(stored.compatReport ?? {}),
      changeSummary:
        typeof stored.changeSummary === "string" ? stored.changeSummary : null,
      publishedById,
      publishedAt:
        typeof stored.publishedAt === "string"
          ? new Date(stored.publishedAt)
          : new Date(),
      releasedAt:
        d.stage === "RELEASED"
          ? typeof stored.releasedAt === "string"
            ? new Date(stored.releasedAt)
            : new Date()
          : null,
      releasedById: d.stage === "RELEASED" ? publishedById : null,
    };
    const collision = await tx.eventSpecVersion.findUnique({ where: { id } });
    if (collision && collision.eventSpecId !== d.id)
      throw new GitOpsError("Frozen event version id belongs to another event");
    await tx.eventSpecVersion.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
    const parsedSource = parseEventDocument(d.spec.record.document);
    if (parsedSource.success)
      await replaceReferences(
        tx,
        { kind: "EVENT_SPEC_VERSION", id },
        collectDocumentEdges(parsedSource.data),
        d.stage === "SNAPSHOT",
      );
  }
  for (const eventId of new Set(events.map((e) => e.id))) {
    const source = events
      .filter((d) => d.id === eventId)
      .toSorted((a, b) => compareVersion(b.version!, a.version!))[0];
    const parsed = parseEventDocument(source.spec.record.document);
    if (parsed.success)
      await replaceReferences(
        tx,
        { kind: "EVENT_SPEC", id: eventId },
        collectDocumentEdges(parsed.data),
        true,
      );
    const latest = (
      await tx.eventSpecVersion.findMany({
        where: { eventSpecId: eventId },
        orderBy: [{ major: "desc" }, { minor: "desc" }, { patch: "desc" }],
        take: 1,
      })
    )[0];
    if (latest)
      await tx.eventSpec.update({
        where: { id: eventId },
        data: { latestVersionId: latest.id },
      });
  }
}
