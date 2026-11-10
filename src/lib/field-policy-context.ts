import {
  entityRetentionPolicy,
  retentionText,
} from "@/lib/compliance/field-protection";

/** Read-only context, never copied into a field override. */
export function fieldPolicyContext(
  metadata: unknown,
  domainPolicy: unknown,
  domainName?: string,
) {
  const entity =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)
      : {};
  const domain =
    domainPolicy && typeof domainPolicy === "object"
      ? (domainPolicy as Record<string, unknown>)
      : {};
  const entityRetention = entityRetentionPolicy(entity);
  const domainRetention = entityRetentionPolicy(domain);
  const owner =
    entity.owner ?? entity.steward ?? domain.owner ?? domain.steward;
  return {
    source: entityRetention
      ? "Entity retention policy"
      : domainRetention
        ? `${domainName || "Domain"} policy template`
        : "Entity / domain policies",
    retention: entityRetention
      ? retentionText(entityRetention)
      : domainRetention
        ? retentionText(domainRetention)
        : undefined,
    owner: typeof owner === "string" ? owner : undefined,
  };
}
