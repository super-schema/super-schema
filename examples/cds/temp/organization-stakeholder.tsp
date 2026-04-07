// ================================================================================================
// ORGANIZATION STAKEHOLDER — Interleaved child of Customer
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Organization stakeholders including owners, directors, and beneficial owners. Used for compliance and KYC verification. Uses synthetic UUID to track stakeholders over time despite name changes.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@deletePattern("HARD_DELETE")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(450)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/stakeholders",
  singularName: "stakeholder",
  pluralName: "stakeholders",
  operations: #["create", "list"],
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
model OrganizationStakeholder {
  @doc("Foreign key to parent customer table (organization). Part of composite primary key.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  @doc("Globally unique UUID for organization_stakeholder. Part of composite primary key.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  stakeholder_id: uuid;

  @doc("Stakeholder legal name stored as JSON containing given_name, surname, middle_name, and suffix. Subject to change over time (tracked via stakeholder_id).")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.organization_stakeholder.stakeholder_name", "AES-GCM")
  @schemaRef("schemas/common/name.json")
  @accessScopes(#["customer:read", "compliance:read"], #["compliance:write"])
  @ownedBy("compliance")
  stakeholder_name: StakeholderName;

  @doc("Stakeholder role in organization for compliance and regulatory reporting.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @maxLength(50)
  @accessScopes(#["customer:read", "compliance:read"], #["compliance:write"])
  @ownedBy("compliance")
  role?: StakeholderRole;

  @doc("Ownership percentage for beneficial ownership compliance (e.g., 25.5 for 25.5% ownership). Optional as not all stakeholder roles have ownership percentage.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @spi @cde
  @accessScopes(#["customer:read", "compliance:read"], #["compliance:write"])
  @ownedBy("compliance")
  ownership_percentage?: decimal;

  @doc("Spanner commit timestamp when stakeholder record was created. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read"])
  time_created: utcDateTime;
}
