// ================================================================================================
// CUSTOMER DATA STORE — TypeSpec Specification
// ================================================================================================
//
// Converted from Cloud Spanner DDL with full metadata preservation.
//
// Design Principles:
//   1. 100% data minimization via column projection
//   2. Collapsed person_profile/business_profile into customer model
//   3. Interleaved tables for multi-valued child entities
//   4. Brand-based namespace (not hard tenant isolation)
//
// Performance Targets:
//   - Home region strong reads: p95 15-25ms
//   - Single table lookup for customer with column projection
//   - Co-located customer + accounts via interleaving
//
// JIRA: DTCDS-113
// ================================================================================================

import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";
import "./decorators.tsp";
import "./enums.tsp";
import "./common-models.tsp";
import "./customer.tsp";
import "./customer-email.tsp";
import "./customer-phone.tsp";
import "./customer-address.tsp";
import "./customer-external-identifier.tsp";
import "./organization-stakeholder.tsp";
import "./login-identifier.tsp";
import "./accessible-resource.tsp";
import "./account.tsp";
import "./account-external-identifier.tsp";
import "./ddl-change-log.tsp";

using TypeSpec.Http;
using TypeSpec.Rest;
using TypeSpec.OpenAPI;

@service({
  title: "Customer Data Store API",
})
@doc("Customer Data Store - Centralized federated customer data management solution with focus on data minimization, tenant isolation, and access policy enforcement.")
@server("https://api.paypal.com", "Production")
namespace PayPal.CustomerDataStore;
