"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { GENERIC_ACTION_ERROR, getActionContext, inActiveTenant } from "@/lib/action-context";
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
 * Session + REAL role (`getActionContext`, the same resolution the Events actions use: the session user mapped to a `User`
 * row, the effective role failing closed to VIEWER) around one product service call. Product service failures keep their
 * message, except `DB_ERROR` / `INTERNAL_ERROR`, which become the generic message; an unexpected throw (the product service
 * rethrows anything that is not a unique-constraint hit) is logged server-side and answered with the generic message too,
 * so the form never sees raw driver text and never hangs on a rejected action. Next's own control-flow throws pass through.
 * A validation failure on the contact fields also carries `fieldErrors` (a message per bad field) so the form can show each
 * one next to its input.
 *
 * `owned` runs before the service: the product actions address a domain (create) or a product (update / delete) by a bare id
 * from the client, and the service trusts it, so the id must belong to the caller's ACTIVE tenant. The answer for a foreign
 * id is exactly the service's own answer for a missing one, so an id guessed from another tenant reveals nothing.
 */
async function runProductAction<T>(
  label: string,
  owned: { kind: "domain" | "product"; id: unknown },
  run: (ctx: ServiceContext) => Promise<Result<T>>
): Promise<ProductActionFailure | { data: T }> {
  try {
    const ctx = await getActionContext();
    if (!ctx) return { error: NOT_LOGGED_IN };
    if (!(await inActiveTenant(owned.kind, owned.id))) {
      return { error: `${owned.kind === "domain" ? "Domain" : "Product"} "${String(owned.id)}" not found` };
    }
    const result = await run(ctx);
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
  const outcome = await runProductAction("createProductAction", { kind: "domain", id: input?.domainId }, (ctx) => createProduct(input, ctx));
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
  const outcome = await runProductAction("updateProductAction", { kind: "product", id }, (ctx) => updateProduct(id, input, ctx));
  // Fresh literals, written here, so the action's return union stays discriminable by `error` / `slug` for its callers.
  if ("error" in outcome) {
    return outcome.fieldErrors ? { error: outcome.error, fieldErrors: outcome.fieldErrors } : { error: outcome.error };
  }

  revalidatePath("/schemas");
  return { success: true, slug: outcome.data.slug };
}

export async function deleteProductAction(id: string) {
  const outcome = await runProductAction("deleteProductAction", { kind: "product", id }, (ctx) => deleteProduct(id, ctx));
  if ("error" in outcome) return { error: outcome.error };

  revalidatePath("/schemas");
  return { success: true };
}
