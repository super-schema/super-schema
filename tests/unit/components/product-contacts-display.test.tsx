/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProductContacts } from "@/app/(dashboard)/schemas/[domainSlug]/components/ProductContacts";

afterEach(() => cleanup());

const NONE = { engineeringLead: null, manager: null, teamEmails: [] };

describe("ProductContacts (product page header)", () => {
  it("renders nothing for a product with no contacts", () => {
    const { container } = render(<ProductContacts contacts={NONE} />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the contacts are missing altogether", () => {
    expect(render(<ProductContacts contacts={undefined} />).container.innerHTML).toBe("");
    cleanup();
    expect(render(<ProductContacts contacts={null} />).container.innerHTML).toBe("");
  });

  it("shows the engineering lead's name as a mailto link, with the address beside it", () => {
    render(<ProductContacts contacts={{ ...NONE, engineeringLead: "Jane Doe <jane@acme.com>" }} />);

    const row = screen.getByTestId("product-contact-engineering-lead");
    expect(within(row).getByText("Engineering Lead")).toBeTruthy();
    const link = within(row).getByRole("link", { name: "Jane Doe" });
    expect(link.getAttribute("href")).toBe("mailto:jane@acme.com");
    expect(row.textContent).toContain("jane@acme.com");
  });

  it("shows the manager, and only the rows that have a value", () => {
    render(<ProductContacts contacts={{ ...NONE, manager: "Mo Manager <mo@acme.com>" }} />);

    expect(screen.getByTestId("product-contact-manager")).toBeTruthy();
    expect(screen.queryByTestId("product-contact-engineering-lead")).toBeNull();
    expect(screen.queryByTestId("product-contact-team")).toBeNull();
    expect(screen.getByRole("link", { name: "Mo Manager" }).getAttribute("href")).toBe("mailto:mo@acme.com");
  });

  it("shows a nameless address as a link whose text is the address", () => {
    render(<ProductContacts contacts={{ ...NONE, manager: "mo@acme.com" }} />);

    const link = screen.getByRole("link", { name: "mo@acme.com" });
    expect(link.getAttribute("href")).toBe("mailto:mo@acme.com");
  });

  it("lists every team address as its own mailto link", () => {
    render(<ProductContacts contacts={{ ...NONE, teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"] }} />);

    const row = screen.getByTestId("product-contact-team");
    expect(within(row).getByText("Team")).toBeTruthy();
    const links = within(row).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["mailto:platform@acme.com", "mailto:oncall@acme.com"]);
    expect(links.map((a) => a.textContent)).toEqual(["Platform Team", "oncall@acme.com"]);
  });

  it("round-trips a display name with a comma: the stored quoted form shows as the plain name", () => {
    render(<ProductContacts contacts={{ ...NONE, engineeringLead: '"Doe, Jane" <j@x.com>', teamEmails: ['"Roe, Rick" <r@x.com>'] }} />);

    expect(screen.getByRole("link", { name: "Doe, Jane" }).getAttribute("href")).toBe("mailto:j@x.com");
    expect(screen.getByRole("link", { name: "Roe, Rick" }).getAttribute("href")).toBe("mailto:r@x.com");
    expect(document.body.textContent).not.toContain('"');
  });

  it("encodes characters that would break a mailto link", () => {
    render(<ProductContacts contacts={{ ...NONE, manager: "a?b&c@acme.com" }} />);

    expect(screen.getByRole("link").getAttribute("href")).toBe("mailto:a%3Fb%26c@acme.com");
  });

  it("shows stored text that is not a valid mailbox as plain text, never as a link", () => {
    render(<ProductContacts contacts={{ ...NONE, manager: "legacy <not valid", teamEmails: ["left over text"] }} />);

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByTestId("product-contact-manager").textContent).toContain("legacy <not valid");
    expect(screen.getByTestId("product-contact-team").textContent).toContain("left over text");
  });

  it("skips blank stored entries", () => {
    render(<ProductContacts contacts={{ ...NONE, manager: "   ", teamEmails: ["", "  "] }} />);

    expect(screen.queryByTestId("product-contacts")).toBeNull();
  });

  it("labels the group for assistive technology", () => {
    render(<ProductContacts contacts={{ ...NONE, manager: "mo@acme.com" }} />);

    expect(screen.getByTestId("product-contacts").getAttribute("aria-label")).toBe("Product contacts");
  });
});
