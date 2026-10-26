import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { APP_ERRORS, withApiAuth } from "@/lib/access/api";

/**
 * The fields the command palette offers: those of the entities of the tenant being viewed that the caller's roles let them read (`entity.read`:
 * a tenant-wide role reads them all, a domain- or product-scoped role only the entities under its domains and products, in the query).
 *
 * A session only. The root middleware (src/middleware.ts) reads the Cookie header and nothing else, so a caller with only an
 * `Authorization: Bearer <API key>` never reaches this handler (it gets 401 there): an API-key branch here could never run.
 * A user with no role in the tenant is told 404, one with a role that reaches no entity 403, and neither is a 500.
 */
export const GET = withApiAuth(
  "entity.read",
  async (_request, api) => {
    try {
      const tenantId = api.tenantId as string; // content action: `withApiAuth` always resolves it
      const scopes = api.scopes;
      const readable = !scopes || scopes.all ? {} : { OR: [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }] };
      const fields = await prisma.field.findMany({
        where: { entity: { tenantId, ...readable } },
        select: {
          id: true,
          slug: true,
          name: true,
          type: true,
          entity: {
            select: {
              id: true,
              name: true,
              slug: true,
              product: { select: { slug: true } },
              domain: {
                select: { name: true, slug: true },
              },
            },
          },
        },
        orderBy: [{ entity: { name: "asc" } }, { name: "asc" }],
        take: 100, // Limit for performance
      });

      return NextResponse.json(
        fields.map((f) => ({
          id: f.id,
          slug: f.slug,
          name: f.name,
          type: f.type,
          entityId: f.entity.id,
          entitySlug: f.entity.slug,
          entityName: f.entity.name,
          // null for a tenant-level entity; the client builds links with assetHref.
          domainSlug: f.entity.domain?.slug ?? null,
          productSlug: f.entity.product?.slug ?? null,
        }))
      );
    } catch {
      return NextResponse.json(
        { error: "Failed to fetch fields" },
        { status: 500 }
      );
    }
  },
  { respond: APP_ERRORS, allowApiKey: false }
);
