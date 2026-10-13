import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface DomainTreeEntity {
  id: string;
  name: string;
  slug: string;
  status: string;
  productSlug: string;
}

export interface DomainTreeNode {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
  entities: DomainTreeEntity[];
  modelCount: number;
  decoratorCount: number;
  sharedEnumCount: number;
  customScalarCount: number;
  unionTypeCount: number;
  serviceCount: number;
}

export const domainsTreeQueryKey = ["domains-tree"] as const;

async function fetchDomainsTree(): Promise<DomainTreeNode[]> {
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
