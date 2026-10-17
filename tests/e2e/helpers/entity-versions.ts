/**
 * Fixtures of entities WITH published versions, for specs that publish events (an event publish needs every pin to name a published
 * entity version).
 *
 * The versions are written straight into the tables: publishing an entity through the app writes an immutable PUBLISH_VERSION audit
 * row that no cleanup can delete. The renderer reads only `resolvedSource`, `fieldSnapshot` and the FIELD pins of a version, so a
 * one-model source is a complete version for it. Everything created here belongs to the fixture domain/product, so
 * `deleteNavFixtures` removes it (the domain delete cascades to entities and their versions).
 */
import { randomBytes } from "node:crypto";
import { TEST_EMAIL } from "./auth";
import { pg, type NavFixtures } from "./db";

export interface PublishedEntity {
  id: string;
  name: string;
  /** The version row ids by label ("1.0"). */
  versionIds: Record<string, string>;
  /** The newest label: what choosing the entity in a picker pins. */
  latestLabel: string;
}

const newId = () => `e2e${randomBytes(10).toString("hex")}`;

/**
 * A product-level entity of the fixture product with one published version per label (oldest first, e.g. `["1.0", "1.1", "2.0"]`).
 * `name` must be a plain TypeSpec identifier (letters and digits): it is the model's name and the entity's.
 */
export async function createPublishedEntity(f: NavFixtures, name: string, labels: readonly string[]): Promise<PublishedEntity> {
  if (labels.length === 0) throw new Error("createPublishedEntity needs at least one version label");
  const db = pg();
  const owner = await db.query(`SELECT id FROM users ORDER BY (email = $1) DESC, "createdAt" ASC LIMIT 1`, [TEST_EMAIL]);
  const ownerId = owner.rows[0]?.id as string | undefined;
  if (!ownerId) throw new Error("E2E fixtures need a seeded user (npm run db:seed).");

  const entityId = newId();
  await db.query(
    `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "hasUnpublishedChanges", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, now())`,
    [entityId, name, name.toLowerCase(), f.tenantId, f.domain.id, f.product.id, ownerId]
  );
  await db.query(
    `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt")
     VALUES ($1, $2, 'id', 'id', 'string', false, true, 0, now())`,
    [newId(), entityId]
  );

  const versionIds: Record<string, string> = {};
  for (const [i, label] of labels.entries()) {
    const [major, minor] = label.split(".").map(Number);
    if (!Number.isInteger(major) || !Number.isInteger(minor)) throw new Error(`"${label}" is not a MAJOR.MINOR version label`);
    const id = newId();
    await db.query(
      `INSERT INTO entity_versions (id, "entityId", major, minor, sequence, "resolvedSource", "fieldSnapshot", "changeKind", "compatReport", "publishedById")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, '{}'::jsonb, $9)`,
      [
        id, entityId, major, minor, i + 1, `model ${name} {\n  id: string;\n}\n`, JSON.stringify([{ name: "id", fieldNumber: 1 }]),
        i === 0 ? "INITIAL" : minor === 0 ? "MAJOR" : "MINOR", ownerId,
      ]
    );
    versionIds[label] = id;
  }
  const latestLabel = labels[labels.length - 1];
  await db.query(`UPDATE entities SET "latestVersionId" = $1 WHERE id = $2`, [versionIds[latestLabel], entityId]);
  return { id: entityId, name, versionIds, latestLabel };
}
