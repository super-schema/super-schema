import { expect, it } from "vitest";
import { deploymentMethodsFor } from "@/lib/deployments/target-methods";
it("defaults schema formats to Git and registry, and database/other targets to Git and API", () => {
  for (const target of ["avro", "json-schema", "protobuf"]) expect(deploymentMethodsFor(target)).toEqual(["git", "registry"]);
  for (const target of ["bigquery", "spanner", "postgresql", "new-datastore"]) expect(deploymentMethodsFor(target)).toEqual(["git", "http"]);
});
it("uses tenant target overrides and the fallback for other targets", () => {
  expect(deploymentMethodsFor("avro", { avro: ["git", "http"] })).toEqual(["git", "http"]);
  expect(deploymentMethodsFor("new-datastore", { "*": ["http"] })).toEqual(["http"]);
  expect(deploymentMethodsFor("protobuf", { "*": ["http"] })).toEqual(["git", "registry"]);
});
