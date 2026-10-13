/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TypeMappingReference } from "@/app/(dashboard)/schemas/type-mappings/type-mapping-reference";

afterEach(() => {
  cleanup();
});

describe("TypeMappingReference", () => {
  it("shows int32 mappings across schema technologies by default", () => {
    render(<TypeMappingReference />);

    expect(screen.getByRole("heading", { name: "Type Mapping Reference" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "int32" })).toBeDefined();
    expect(screen.getAllByText("32-bit signed integer (most common)").length).toBeGreaterThan(0);

    const table = screen.getByRole("table", { name: "Type mappings for int32" });
    const bigQueryRow = within(table).getByText("BigQuery DDL").closest("tr");
    const avroRow = within(table).getByText("Avro Schema").closest("tr");
    const spannerRow = within(table).getByText("Spanner DDL").closest("tr");
    const postgresqlRow = within(table).getByText("PostgreSQL DDL").closest("tr");

    expect(bigQueryRow).not.toBeNull();
    expect(avroRow).not.toBeNull();
    expect(spannerRow).not.toBeNull();
    expect(postgresqlRow).not.toBeNull();
    expect(within(bigQueryRow!).getByText("INT64")).toBeDefined();
    expect(within(bigQueryRow!).getByText("Safe mapping")).toBeDefined();
    expect(within(avroRow!).getByText("int")).toBeDefined();
    expect(within(spannerRow!).getByText("INT64")).toBeDefined();
    expect(within(spannerRow!).getByText("Validation risk")).toBeDefined();
    expect(within(postgresqlRow!).getByText("integer")).toBeDefined();
  });

  it("lets users search and inspect risky decimal mappings", () => {
    render(<TypeMappingReference />);

    const search = screen.getByRole("searchbox", { name: "Search logical types" });
    fireEvent.change(search, { target: { value: "decimal" } });
    fireEvent.click(screen.getByRole("button", { name: /decimal Exact decimal/i }));

    expect(screen.getByRole("heading", { name: "decimal" })).toBeDefined();
    expect(screen.getAllByText("Exact decimal — no rounding (money, finance)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Precision risk").length).toBeGreaterThan(0);
  });

  it("announces selected and empty search states", () => {
    render(<TypeMappingReference />);

    expect(screen.getByRole("button", { name: /int32 32-bit signed integer/i }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search logical types" }), {
      target: { value: "not-a-real-type" },
    });

    expect(screen.getByText("No logical types match that search.")).toBeDefined();
  });
});
