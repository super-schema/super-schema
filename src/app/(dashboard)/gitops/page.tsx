import { redirect } from "next/navigation";

/** Moved to Admin › Workflows › GitOps; query parameters (productId, connected) are kept. */
export default async function GitOpsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const value of [v].flat()) if (value !== undefined) query.append(k, value);
  redirect(`/admin/workflows/gitops${query.size ? `?${query}` : ""}`);
}
