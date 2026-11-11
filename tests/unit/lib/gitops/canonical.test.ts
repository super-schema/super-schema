import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  canonicalPath,
  blobHash,
  parseCanonical,
  serializeDocument,
  validateRepository as validateTree,
  promoteDocument,
} from "@/lib/gitops/canonical";
import {
  BindingSchema,
  GitOpsError,
  type CanonicalDocument,
} from "@/lib/gitops/contracts";
import { mergeDocuments } from "@/lib/gitops/merge";
import {
  contentStorage,
  assertContentWrite,
  withProjectionWrites,
} from "@/lib/gitops/mode";
import { verifyWebhook, GitHubProvider } from "@/lib/gitops/provider";

const doc = (): CanonicalDocument => ({
  apiVersion: "superschema.io/v1",
  kind: "Entity",
  id: "account",
  version: "1.0.0_snapshot",
  stage: "SNAPSHOT",
  scope: {
    tenantId: "t",
    tenantSlug: "tenant",
    domainId: "d",
    domainSlug: "identity",
    productId: "p",
    productSlug: "accounts",
  },
  owners: [],
  references: [],
  spec: {
    versionRecord: { id: "account-version-1" },
    record: {
      id: "account",
      name: "Account",
      slug: "account",
      tenantId: "t",
      domainId: "d",
      productId: "p",
      description: "Multiline\nUnicode café 🦊",
      metadata: { custom: { arbitrary: [1, null, true] } },
      ownerId: "author",
    },
    children: {
      fields: [
        {
          id: "field",
          entityId: "account",
          name: "id",
          type: "uuid",
          nullable: false,
          decorators: { typespec: { identity: { format: "uuid" } } },
        },
      ],
    },
  },
});
function validateRepository(
  files: Parameters<typeof validateTree>[0],
  root: string,
  previous: Parameters<typeof validateTree>[2] = [],
) {
  const scope = doc().scope;
  const hierarchy: CanonicalDocument[] = [
    {
      apiVersion: "superschema.io/v1",
      kind: "Tenant",
      id: "t",
      scope: { tenantId: "t", tenantSlug: "tenant" },
      owners: [],
      references: [],
      spec: {
        record: { id: "t", name: "Tenant", slug: "tenant" },
        children: {},
      },
    },
    {
      apiVersion: "superschema.io/v1",
      kind: "Domain",
      id: "d",
      scope: {
        tenantId: "t",
        tenantSlug: "tenant",
        domainId: "d",
        domainSlug: "identity",
      },
      owners: [],
      references: [],
      spec: {
        record: { id: "d", name: "Identity", slug: "identity", tenantId: "t" },
        children: {},
      },
    },
    {
      apiVersion: "superschema.io/v1",
      kind: "Product",
      id: "p",
      scope,
      owners: [],
      references: [],
      spec: {
        record: { id: "p", name: "Accounts", slug: "accounts", domainId: "d" },
        children: {},
      },
    },
  ];
  return validateTree(
    [
      ...hierarchy.map((d) => ({
        path: canonicalPath(root, d),
        content: serializeDocument(d),
      })),
      ...files,
    ],
    root,
    previous,
  );
}
const original = process.env.CONTENT_STORAGE;
afterEach(() => {
  if (original === undefined) delete process.env.CONTENT_STORAGE;
  else process.env.CONTENT_STORAGE = original;
});
describe("canonical Git content and root ownership", () => {
  it("round trips nested decorators, nulls, Unicode and multiline documentation deterministically", () => {
    const d = doc();
    const text = serializeDocument(d);
    expect(parseCanonical(text)).toEqual(d);
    expect(serializeDocument(parseCanonical(text))).toBe(text);
  });
  it("rejects a new snapshot that reuses a released version identity", () => {
    const released = promoteDocument(doc()),
      snapshot = doc();
    snapshot.version = "1.0.1_snapshot";
    snapshot.spec.record.description = "Next documentation revision";
    const result = validateRepository(
      [released, snapshot].map((d) => ({
        path: canonicalPath("", d),
        content: serializeDocument(d),
      })),
      "",
    );
    expect(
      result.errors.some((e) =>
        e.message.includes("Frozen version id is reused"),
      ),
    ).toBe(true);
  });
  it.each(["", "contracts", "schema/storage"])(
    "uses the configured repository root %j",
    (root) => {
      const path = canonicalPath(root, doc());
      expect(path).toBe(
        `${root ? `${root}/` : ""}domains/identity/products/accounts/entities/account/1.0.0_snapshot/entity.yaml`,
      );
      expect(
        validateRepository([{ path, content: serializeDocument(doc()) }], root)
          .errors,
      ).toEqual([]);
    },
  );
  it.each(["../escape", "/absolute", "x/../y", "x\\y", "x/", "a//b"])(
    "rejects unsafe roots %j",
    (basePath) =>
      expect(() =>
        BindingSchema.parse({
          repositoryUrl: "https://github.com/o/r",
          installationId: "1",
          basePath,
        }),
      ).toThrow(),
  );
  it("rejects a canonical file outside the root", () => {
    expect(
      validateRepository(
        [{ path: canonicalPath("", doc()), content: serializeDocument(doc()) }],
        "scoped",
      ).errors[0].message,
    ).toContain("path");
  });
  it("rejects duplicate YAML keys and alias bombs", () => {
    expect(() => parseCanonical("kind: Entity\nkind: Event")).toThrow();
    expect(() => parseCanonical("a: &a [*a]")).toThrow();
  });
  it("rejects another object's child row", () => {
    const d = doc();
    d.spec.children.fields[0].entityId = "another";
    expect(() => serializeDocument(d)).toThrow("another object");
  });
  it("rejects a released document's mutation or deletion", () => {
    const d = promoteDocument(doc()),
      path = canonicalPath("root", d),
      content = serializeDocument(d);
    const next = structuredClone(d);
    next.spec.record.description = "edited";
    expect(
      validateRepository([{ path, content: serializeDocument(next) }], "root", [
        { path, content },
      ]).errors[0].message,
    ).toContain("immutable");
    expect(
      validateRepository([], "root", [{ path, content }]).errors[0].message,
    ).toContain("immutable");
  });
  it("rejects released references to snapshots", () => {
    const d = promoteDocument(doc());
    d.references = [{ kind: "Entity", id: "other", version: "1.0.0_snapshot" }];
    const dep = doc();
    dep.id = "other";
    dep.spec.versionRecord = {id:"other-version-1"};
    dep.spec.record.id = "other";
    dep.spec.record.slug = "other";
    dep.spec.children = {};
    expect(
      validateRepository(
        [d, dep].map((v) => ({
          path: canonicalPath("", v),
          content: serializeDocument(v),
        })),
        "",
      ).errors[0].message,
    ).toContain("not released");
  });
  it("matches Git's blob identity", () =>
    expect(blobHash("test content\n")).toBe(
      "d670460b4b4aece5915caf5c68d12f560a9fe3e4",
    ));
});
describe("structured three-way merge", () => {
  it("merges edits to separate fields identified by stable id", () => {
    const base = {
      fields: [
        { id: "a", description: "old" },
        { id: "b", description: "old" },
      ],
    };
    const theirs = {
      fields: [
        { id: "a", description: "remote" },
        { id: "b", description: "old" },
      ],
    };
    const ours = {
      fields: [
        { id: "a", description: "old" },
        { id: "b", description: "local" },
      ],
    };
    expect(mergeDocuments(base, theirs, ours)).toEqual({
      value: {
        fields: [
          { id: "a", description: "remote" },
          { id: "b", description: "local" },
        ],
      },
      conflicts: [],
    });
  });
  it("reports edit/delete and conflicting scalar edits", () => {
    expect(
      mergeDocuments(
        { id: "x", value: 1 },
        { id: "x", value: 2 },
        { id: "x", value: 3 },
      ).conflicts,
    ).toHaveLength(1);
    expect(
      mergeDocuments([{ id: "x", v: 1 }], [], [{ id: "x", v: 2 }]).conflicts,
    ).toHaveLength(1);
  });
});
describe("source-of-truth guard and webhook authentication", () => {
  it("defaults to database and rejects unknown storage modes", () => {
    expect(contentStorage({})).toBe("database");
    expect(() => contentStorage({ CONTENT_STORAGE: "typo" })).toThrow(
      GitOpsError,
    );
  });
  it("guards direct and nested content writes", () => {
    process.env.CONTENT_STORAGE = "git";
    expect(() => assertContentWrite("Field", "update")).toThrow(
      "source of truth",
    );
    expect(() =>
      assertContentWrite("User", "update", {
        data: { entities: { create: {} } },
      }),
    ).toThrow();
    expect(() => assertContentWrite("Entity", "findMany")).not.toThrow();
  });
  it("isolates the internal projection scope across concurrent async flows", async () => {
    process.env.CONTENT_STORAGE = "git";
    await Promise.all([
      withProjectionWrites(async () => {
        await Promise.resolve();
        expect(() => assertContentWrite("Field", "create")).not.toThrow();
      }),
      Promise.resolve().then(() =>
        expect(() => assertContentWrite("Field", "create")).toThrow(),
      ),
    ]);
  });
  it("verifies the exact raw webhook bytes", () => {
    const body = '{"action":"opened"}',
      secret = "secret",
      signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyWebhook(body, signature, secret)).toBe(true);
    expect(verifyWebhook(body + " ", signature, secret)).toBe(false);
    expect(verifyWebhook(body, null, secret)).toBe(false);
  });
  it("rejects a provider write outside its root before making a network call", async () => {
    const p = new GitHubProvider("https://github.com/o/r", "not-sent");
    await expect(
      p.commit({
        root: "storage",
        baseBranch: "main",
        baseSha: "base",
        branch: "test",
        files: [{ path: "outside.yaml", content: "x" }],
        title: "x",
        body: "",
        marker: "m",
      }),
    ).rejects.toThrow("Unsafe");
  });
});
