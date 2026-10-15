"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { GENERIC_ACTION_ERROR, getActionContext } from "@/lib/action-context";
import { isOpaqueErrorCode } from "@/types/action-result";
import type { Result } from "@/types/result";
import {
  createProduct,
  updateProduct,
  deleteProduct,
} from "@/services/product.service";
import type { ServiceContext } from "@/types/service-context";

const NOT_LOGGED_IN = "You must be logged in";

/**
 * Session + REAL role (`getActionContext`, the same resolution the Events actions use: the session user mapped to a `User`
 * row, the effective role failing closed to VIEWER) around one product service call. Product service failures keep their
 * message, except `DB_ERROR` / `INTERNAL_ERROR`, which become the generic message; an unexpected throw (the product service
 * rethrows anything that is not a unique-constraint hit) is logged server-side and answered with the generic message too,
 * so the form never sees raw driver text and never hangs on a rejected action. Next's own control-flow throws pass through.
 */
async function runProductAction<T>(
  label: string,
  run: (ctx: ServiceContext) => Promise<Result<T>>
): Promise<{ error: string } | { data: T }> {
  try {
    const ctx = await getActionContext();
    if (!ctx) return { error: NOT_LOGGED_IN };
    const result = await run(ctx);
    if (!result.success) {
      return { error: isOpaqueErrorCode(result.error.code) ? GENERIC_ACTION_ERROR : result.error.message };
    }
    return { data: result.data };
  } catch (e: unknown) {
    unstable_rethrow(e);
    console.error(`[${label}] unexpected error`, e);
    return { error: GENERIC_ACTION_ERROR };
  }
}

export async function createProductAction(input: {
  domainId: string;
  name: string;
  description?: string;
  tierId?: string | null;
  ownerTeam?: string | null;
}) {
  const outcome = await runProductAction("createProductAction", (ctx) => createProduct(input, ctx));
  if ("error" in outcome) return { error: outcome.error };

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
  }
) {
  const outcome = await runProductAction("updateProductAction", (ctx) => updateProduct(id, input, ctx));
  if ("error" in outcome) return { error: outcome.error };

  revalidatePath("/schemas");
  return { success: true, slug: outcome.data.slug };
}

export async function deleteProductAction(id: string) {
  const outcome = await runProductAction("deleteProductAction", (ctx) => deleteProduct(id, ctx));
  if ("error" in outcome) return { error: outcome.error };

  revalidatePath("/schemas");
  return { success: true };
}
