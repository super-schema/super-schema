/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EntityCard } from "@/components/custom/EntityCard";

afterEach(cleanup);

function card(fieldCount: number) {
  render(
    <EntityCard
      id="e1"
      name="Order"
      slug="order"
      description=""
      status="DRAFT"
      version={1}
      fieldCount={fieldCount}
      domainName="Billing"
      domainSlug="billing"
      productSlug="ledger"
      updatedAt={new Date("2026-01-01T00:00:00.000Z")}
    />
  );
}

describe("EntityCard field count", () => {
  it.each([
    [0, "0 fields"],
    [1, "1 field"],
    [2, "2 fields"],
  ])("%i field(s) reads %j", (count, text) => {
    card(count);
    expect(screen.getByText(text, { exact: true })).toBeTruthy();
    expect(screen.queryByText("1 fields")).toBeNull();
  });
});
