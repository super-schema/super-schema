import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExplorerTree } from "@/lib/navigation/build-explorer-tree";

export type {
  ExplorerCounts,
  ExplorerDomain,
  ExplorerEntity,
  ExplorerProduct,
  ExplorerTree,
} from "@/lib/navigation/build-explorer-tree";

export const domainsTreeQueryKey = ["domains-tree"] as const;

async function fetchDomainsTree(): Promise<ExplorerTree> {
  const response = await fetch("/api/domains-tree");

  if (!response.ok) {
    throw new Error("Failed to load domains tree");
  }

  return response.json();
}

export function useDomainsTree() {
  return useQuery({
    queryKey: domainsTreeQueryKey,
    queryFn: fetchDomainsTree,
    staleTime: 60_000,
  });
}

export function useInvalidateDomainsTree() {
  const queryClient = useQueryClient();

  return () => queryClient.invalidateQueries({ queryKey: domainsTreeQueryKey });
}
