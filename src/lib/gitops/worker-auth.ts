import { timingSafeEqual } from "node:crypto";
export function authorizedGitOpsWorker(header: string | null): boolean {
  const token = process.env.GITOPS_WORKER_TOKEN;
  if (!token || token.length < 32) return false;
  const actual = Buffer.from(header ?? ""),
    expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
