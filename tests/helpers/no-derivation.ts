/**
 * The metadata-rederive service for an action test whose prisma mock knows nothing of attribute definitions: a tenant without
 * definitions (no derivation context), so the action's decorators pass through unchanged.
 *
 *   vi.mock("@/services/metadata-rederive.service", async () => (await import("../../helpers/no-derivation")).noDerivationModule);
 */
export const noDerivationModule = {
  loadDerivationContext: async () => null,
  deriveFieldDecorators: (_ctx: unknown, field: { decorators: unknown }) => field.decorators,
  rederiveForLevel: async () => 0,
  rederiveTenant: async () => 0,
};
