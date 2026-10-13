"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { ServiceContext } from "@/types/service-context";
import {
  createProduct,
  updateProduct,
  deleteProduct,
} from "@/services/product.service";

async function requireContext(): Promise<
  { ctx: ServiceContext } | { error: string }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in" };
  }
  return {
    ctx: {
      userId: session.user.id,
      userRole: "AUTHOR",
      prisma,
    },
  };
}

export async function createProductAction(input: {
  domainId: string;
  name: string;
  description?: string;
  tierId?: string | null;
  ownerTeam?: string | null;
}) {
  const auth = await requireContext();
  if ("error" in auth) return { error: auth.error };

  const result = await createProduct(input, auth.ctx);
  if (!result.success) {
    return { error: result.error.message };
  }

  revalidatePath("/schemas");
  revalidatePath(`/schemas`);
  return { success: true, productId: result.data.id, slug: result.data.slug };
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
  const auth = await requireContext();
  if ("error" in auth) return { error: auth.error };

  const result = await updateProduct(id, input, auth.ctx);
  if (!result.success) {
    return { error: result.error.message };
  }

  revalidatePath("/schemas");
  return { success: true, slug: result.data.slug };
}

export async function deleteProductAction(id: string) {
  const auth = await requireContext();
  if ("error" in auth) return { error: auth.error };

  const result = await deleteProduct(id, auth.ctx);
  if (!result.success) {
    return { error: result.error.message };
  }

  revalidatePath("/schemas");
  return { success: true };
}
