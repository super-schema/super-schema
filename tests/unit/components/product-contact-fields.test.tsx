/**
 * @vitest-environment jsdom
 */
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProductContactFields } from "@/app/(dashboard)/schemas/[domainSlug]/components/ProductContactFields";
import { EMPTY_PRODUCT_CONTACTS_DRAFT, type ProductContactErrors, type ProductContactsDraft } from "@/lib/product-contacts";

/** The fields in a tiny stateful harness, with the state exposed so a test can read what a parent form would submit. */
let latest: { draft: ProductContactsDraft; errors: ProductContactErrors };

function Harness({
  initial = EMPTY_PRODUCT_CONTACTS_DRAFT,
  initialErrors = {},
}: {
  initial?: ProductContactsDraft;
  initialErrors?: ProductContactErrors;
}) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<ProductContactErrors>(initialErrors);
  useEffect(() => {
    latest = { draft, errors };
  }, [draft, errors]);
  return <ProductContactFields value={draft} errors={errors} onChange={setDraft} onErrorsChange={setErrors} />;
}

const teamInput = () => screen.getByTestId("product-team-emails-input") as HTMLInputElement;
const leadInput = () => screen.getByTestId("product-engineering-lead-input") as HTMLInputElement;
const managerInput = () => screen.getByTestId("product-manager-input") as HTMLInputElement;
const chips = () => screen.queryAllByTestId("product-team-emails-chip");

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function press(input: HTMLInputElement, key: string) {
  return fireEvent.keyDown(input, { key });
}

function paste(input: HTMLInputElement, text: string) {
  return fireEvent.paste(input, { clipboardData: { getData: () => text } });
}

afterEach(() => cleanup());

describe("ProductContactFields: labelled inputs", () => {
  it("renders Engineering Lead, Manager and Team email addresses, each with a label wired to its input", () => {
    render(<Harness />);

    expect(screen.getByLabelText("Engineering Lead")).toBe(leadInput());
    expect(screen.getByLabelText("Manager")).toBe(managerInput());
    expect(screen.getByLabelText("Team email addresses")).toBe(teamInput());
  });

  it("uses the name-and-address placeholder on the lead and manager inputs", () => {
    render(<Harness />);

    expect(leadInput().placeholder).toBe("Jane Doe <jane@acme.com>");
    expect(managerInput().placeholder).toBe("Jane Doe <jane@acme.com>");
  });

  it("shows the typed text of the lead and manager inputs and reports it through onChange", () => {
    render(<Harness />);

    type(leadInput(), "Jane Doe <jane@acme.com>");
    type(managerInput(), "mo@acme.com");

    expect(leadInput().value).toBe("Jane Doe <jane@acme.com>");
    expect(latest.draft.engineeringLead).toBe("Jane Doe <jane@acme.com>");
    expect(latest.draft.manager).toBe("mo@acme.com");
  });

  it("starts with no chips and no errors", () => {
    render(<Harness />);

    expect(chips()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ProductContactFields: lead and manager validation", () => {
  it("shows an inline error when a filled-in lead is left with a malformed address, and marks the input invalid", () => {
    render(<Harness />);

    type(leadInput(), "jane");
    fireEvent.blur(leadInput());

    const error = screen.getByTestId("product-engineering-lead-error");
    expect(error.textContent).toContain("jane");
    expect(leadInput().getAttribute("aria-invalid")).toBe("true");
    expect(leadInput().getAttribute("aria-describedby")).toContain(error.id);
  });

  it("accepts a name with a quoted comma and shows no error", () => {
    render(<Harness />);

    type(managerInput(), '"Doe, Jane" <j@x.com>');
    fireEvent.blur(managerInput());

    expect(screen.queryByTestId("product-manager-error")).toBeNull();
    expect(managerInput().getAttribute("aria-invalid")).not.toBe("true");
  });

  it("does not complain about a blank lead or manager (both are optional)", () => {
    render(<Harness />);

    type(leadInput(), "   ");
    fireEvent.blur(leadInput());
    fireEvent.blur(managerInput());

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears the error as soon as the person edits the field again", () => {
    render(<Harness />);
    type(leadInput(), "jane");
    fireEvent.blur(leadInput());
    expect(screen.getByTestId("product-engineering-lead-error")).toBeTruthy();

    type(leadInput(), "jane@");

    expect(screen.queryByTestId("product-engineering-lead-error")).toBeNull();
  });

  it("shows errors handed in by the parent (a failed submit or a server response)", () => {
    render(<Harness initialErrors={{ manager: "Manager message", teamEmails: "Team message" }} />);

    expect(screen.getByTestId("product-manager-error").textContent).toBe("Manager message");
    expect(screen.getByTestId("product-team-emails-error").textContent).toBe("Team message");
    expect(teamInput().getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByTestId("product-engineering-lead-error")).toBeNull();
  });
});

describe("ProductContactFields: team email chips", () => {
  it("adds a chip on Enter, showing the name and the address, and clears the input", () => {
    render(<Harness />);
    type(teamInput(), "Platform Team <platform@acme.com>");

    press(teamInput(), "Enter");

    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toContain("Platform Team");
    expect(chips()[0].textContent).toContain("platform@acme.com");
    expect(teamInput().value).toBe("");
    expect(latest.draft.teamEmails).toEqual(["Platform Team <platform@acme.com>"]);
  });

  it("shows a bare address chip as just the address", () => {
    render(<Harness />);
    type(teamInput(), "oncall@acme.com");
    press(teamInput(), "Enter");

    expect(chips()[0].textContent).toContain("oncall@acme.com");
    expect(latest.draft.teamEmails).toEqual(["oncall@acme.com"]);
  });

  it("adds a chip when a comma or semicolon is typed, and swallows the separator", () => {
    render(<Harness />);
    type(teamInput(), "a@acme.com");
    const commaAccepted = press(teamInput(), ",");
    type(teamInput(), "b@acme.com");
    const semicolonAccepted = press(teamInput(), ";");

    expect(commaAccepted).toBe(false);
    expect(semicolonAccepted).toBe(false);
    expect(latest.draft.teamEmails).toEqual(["a@acme.com", "b@acme.com"]);
    expect(teamInput().value).toBe("");
  });

  it("does not end the entry on a comma typed inside a quoted display name", () => {
    render(<Harness />);
    type(teamInput(), '"Doe');

    const accepted = press(teamInput(), ",");

    expect(accepted).toBe(true);
    expect(chips()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("round-trips a quoted name with a comma into one chip", () => {
    render(<Harness />);
    type(teamInput(), '"Doe, Jane" <j@x.com>');

    press(teamInput(), "Enter");

    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toContain("Doe, Jane");
    expect(chips()[0].textContent).toContain("j@x.com");
    expect(latest.draft.teamEmails).toEqual(['"Doe, Jane" <j@x.com>']);
  });

  it("commits the pending text when the input loses focus", () => {
    render(<Harness />);
    type(teamInput(), "a@acme.com");

    fireEvent.blur(teamInput());

    expect(latest.draft.teamEmails).toEqual(["a@acme.com"]);
    expect(teamInput().value).toBe("");
  });

  it("splits a pasted list into one chip per address (comma, semicolon and newline separated)", () => {
    render(<Harness />);

    paste(teamInput(), 'a@acme.com, Bee <b@acme.com>; "Doe, Jane" <j@x.com>\nc@acme.com');

    expect(latest.draft.teamEmails).toEqual(["a@acme.com", "Bee <b@acme.com>", '"Doe, Jane" <j@x.com>', "c@acme.com"]);
    expect(chips()).toHaveLength(4);
    expect(teamInput().value).toBe("");
  });

  it("lets a paste with no separator go into the input like normal text", () => {
    render(<Harness />);

    const notPrevented = paste(teamInput(), "a@acme.com");

    expect(notPrevented).toBe(true);
    expect(chips()).toHaveLength(0);
  });

  it("merges a pasted list with the text already typed", () => {
    render(<Harness />);
    type(teamInput(), "first@acme.com");
    teamInput().setSelectionRange(14, 14);

    paste(teamInput(), ", second@acme.com, third@acme.com");

    expect(latest.draft.teamEmails).toEqual(["first@acme.com", "second@acme.com", "third@acme.com"]);
  });

  it("keeps the valid addresses of a paste as chips and leaves the invalid ones in the input with an inline error", () => {
    render(<Harness />);

    paste(teamInput(), "a@acme.com, not-an-address, b@acme.com, also bad");

    expect(latest.draft.teamEmails).toEqual(["a@acme.com", "b@acme.com"]);
    expect(teamInput().value).toBe("not-an-address, also bad");
    const error = screen.getByTestId("product-team-emails-error");
    expect(error.textContent).toContain("not-an-address");
    expect(teamInput().getAttribute("aria-invalid")).toBe("true");
  });

  it("shows an inline error for a single invalid address and keeps it in the input to fix", () => {
    render(<Harness />);
    type(teamInput(), "nope");

    press(teamInput(), "Enter");

    expect(chips()).toHaveLength(0);
    expect(teamInput().value).toBe("nope");
    expect(screen.getByTestId("product-team-emails-error").textContent).toContain("nope");
  });

  it("clears the team error when the person types again", () => {
    render(<Harness />);
    type(teamInput(), "nope");
    press(teamInput(), "Enter");
    expect(screen.getByTestId("product-team-emails-error")).toBeTruthy();

    type(teamInput(), "nope@acme.com");

    expect(screen.queryByTestId("product-team-emails-error")).toBeNull();
  });

  it("collapses a duplicate address (case-insensitively) instead of adding a second chip", () => {
    render(<Harness />);
    type(teamInput(), "Ops <ops@acme.com>");
    press(teamInput(), "Enter");

    type(teamInput(), "OPS@ACME.COM");
    press(teamInput(), "Enter");

    expect(chips()).toHaveLength(1);
    expect(latest.draft.teamEmails).toEqual(["Ops <ops@acme.com>"]);
    expect(teamInput().value).toBe("");
    expect(screen.queryByTestId("product-team-emails-error")).toBeNull();
  });

  it("ignores Enter on an empty input", () => {
    render(<Harness />);

    press(teamInput(), "Enter");

    expect(chips()).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("removes a chip with its remove button, which names the address it removes", () => {
    render(<Harness initial={{ ...EMPTY_PRODUCT_CONTACTS_DRAFT, teamEmails: ["a@acme.com", "Bee <b@acme.com>"] }} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove b@acme.com" }));

    expect(latest.draft.teamEmails).toEqual(["a@acme.com"]);
    expect(chips()).toHaveLength(1);
  });

  it("removes the last chip on Backspace when the input is empty, but not while there is text", () => {
    render(<Harness initial={{ ...EMPTY_PRODUCT_CONTACTS_DRAFT, teamEmails: ["a@acme.com", "b@acme.com"] }} />);
    type(teamInput(), "x");
    press(teamInput(), "Backspace");
    expect(latest.draft.teamEmails).toEqual(["a@acme.com", "b@acme.com"]);

    type(teamInput(), "");
    press(teamInput(), "Backspace");

    expect(latest.draft.teamEmails).toEqual(["a@acme.com"]);
  });

  it("renders existing chips from the draft, one list item each, inside a labelled list", () => {
    render(<Harness initial={{ ...EMPTY_PRODUCT_CONTACTS_DRAFT, teamEmails: ["a@acme.com", '"Doe, Jane" <j@x.com>'] }} />);

    const list = screen.getByTestId("product-team-emails-chips");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list.getAttribute("aria-label")).toBe("Added team email addresses");
  });

  it("shows a chip whose stored text is not parseable as its raw text, without a crash", () => {
    render(<Harness initial={{ ...EMPTY_PRODUCT_CONTACTS_DRAFT, teamEmails: ["legacy text"] }} />);

    expect(chips()[0].textContent).toContain("legacy text");
  });
});
