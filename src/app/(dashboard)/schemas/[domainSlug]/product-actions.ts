"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import type { ActionId } from "@/lib/access";
import { GENERIC_ACTION_ERROR, authorizeSubject, contextOf } from "@/lib/action-context";
import { isOpaqueErrorCode } from "@/types/action-result";
import type { Result } from "@/types/result";
import type { ProductContactErrors, ProductContactsInput } from "@/lib/product-contacts";
import {
  createProduct,
  updateProduct,
  deleteProduct,
} from "@/services/product.service";
import type { ServiceContext } from "@/types/service-context";

const NOT_LOGGED_IN = "You must be logged in";

type ProductActionFailure = { error: string; fieldErrors?: ProductContactErrors };

const CONTACT_FIELDS = ["engineeringLead", "manager", "teamEmails"] as const;

/** The per-field contact messages a service validation failure carries in `details.fieldErrors`: known fields, string messages only. */
function contactFieldErrors(details: object | undefined): ProductContactErrors | undefined {
  const raw = (details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
  if (!raw || typeof raw !== "object") return undefined;
  const picked: ProductContactErrors = {};
  for (const field of CONTACT_FIELDS) {
    const message = raw[field];
    if (typeof message === "string" && message !== "") picked[field] = message;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * The guard and the context around one product service call. `authorizeSubject` decides FIRST, before the service or any other read of the
 * product: the row the id names must lie in the ACTIVE tenant and the caller's roles must reach `action` over it (create: `product.create`
 * over the domain it goes into, update: `product.update` over the product, delete: `product.delete`, a tenant administrator's act). The
 * missing row, the row of another tenant and the row nothing of the caller's covers all answer the very text the service gives a missing
 * one (`Domain "x" not found`), so an id guessed from another tenant reveals nothing; too low a role is a generic refusal; nobody signed in is
 * told to log in. The service context is the principal's (`contextOf`: the user and the assignments, no role label).
 *
 * Product service failures keep their message, except `DB_ERROR` / `INTERNAL_ERROR`, which become the generic message; an unexpected throw
 * (the product service rethrows anything that is not a unique-constraint hit) is logged server-side and answered with the generic message too,
 * so the form never sees raw driver text and never hangs on a rejected action. Next's own control-flow throws pass through.
 * A validation failure on the contact fields also carries `fieldErrors` (a message per bad field) so the form can show each
 * one next to its input.
 */
async function runProductAction<T>(
  label: string,
  action: ActionId,
  owned: { kind: "domain" | "product"; id: unknown },
  run: (ctx: ServiceContext) => Promise<Result<T>>
): Promise<ProductActionFailure | { data: T }> {
  try {
    const missing = {
      code: "NOT_FOUND" as const,
      message: `${owned.kind === "domain" ? "Domain" : "Product"} "${typeof owned.id === "string" ? owned.id : ""}" not found`,
    };
    const access = await authorizeSubject(action, { kind: owned.kind, id: owned.id }, missing);
    if (!access.success) return { error: access.error.code === "UNAUTHORIZED" ? NOT_LOGGED_IN : access.error.message };
    const result = await run(contextOf(access.data.principal));
    if (!result.success) {
      if (isOpaqueErrorCode(result.error.code)) return { error: GENERIC_ACTION_ERROR };
      const fieldErrors = contactFieldErrors(result.error.details);
      return fieldErrors ? { error: result.error.message, fieldErrors } : { error: result.error.message };
    }
    return { data: result.data };
  } catch (e: unknown) {
    unstable_rethrow(e);
    console.error(`[${label}] unexpected error`, e);
    return { error: GENERIC_ACTION_ERROR };
  }
}

export async function createProductAction(
  input: {
    domainId: string;
    name: string;
    description?: string;
    tierId?: string | null;
    ownerTeam?: string | null;
  } & ProductContactsInput
) {
  const outcome = await runProductAction("createProductAction", "product.create", { kind: "domain", id: input?.domainId }, (ctx) => createProduct(input, ctx));
  // Fresh literals, written here, so the action's return union stays discriminable by `error` / `slug` for its callers.
  if ("error" in outcome) {
    return outcome.fieldErrors ? { error: outcome.error, fieldErrors: outcome.fieldErrors } : { error: outcome.error };
  }

  revalidatePath("/schemas");
  return { success: true, productId: outcome.data.id, slug: outcome.data.slug };
}

export async function updateProductAction(
  id: string,
  input: {
    name?: string;
    description?: string;
    tierId?: string | null;
    ownerTeam?: string | null;
  } & ProductContactsInput
) {
  const outcome = await runProductAction("updateProductAction", "product.update", { kind: "product", id }, (ctx) => updateProduct(id, input, ctx));
  // Fresh literals, written here, so the action's return union stays discriminable by `error` / `slug` for its callers.
  if ("error" in outcome) {
    return outcome.fieldErrors ? { error: outcome.error, fieldErrors: outcome.fieldErrors } : { error: outcome.error };
  }

  revalidatePath("/schemas");
  return { success: true, slug: outcome.data.slug };
}

export async function deleteProductAction(id: string) {
  const outcome = await runProductAction("deleteProductAction", "product.delete", { kind: "product", id }, (ctx) => deleteProduct(id, ctx));
  if ("error" in outcome) return { error: outcome.error };

  revalidatePath("/schemas");
  return { success: true };
}
