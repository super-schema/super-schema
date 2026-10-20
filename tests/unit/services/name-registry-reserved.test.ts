import { describe, expect, it } from "vitest";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";
import { assertNameAvailable } from "@/services/name-registry.service";
import { emptyRegistryDelegates } from "../../helpers/registry-mocks";

// The name registry is the one place every create and rename of an entity, enum, scalar, union, API, trait and event goes through
// (`writeWithUniqueName`): a name that is a parser-unsafe key (`PARSER_UNSAFE_KEYS`) becomes a definition / component key of the AsyncAPI
// document, which the parser cannot read, so it is refused there, for every kind, with the wording `reservedNameMessage` owns.

const [UNSAFE] = [...PARSER_UNSAFE_KEYS];
const T = "t1";
const place = { tenantId: T, domainId: "d1", productId: null };
const message = (name: string) => `"${name}" is a reserved name: AsyncAPI documents cannot contain it. Choose another name.`;
const fakeDb = (rows: Parameters<typeof emptyRegistryDelegates>[0] = {}) => emptyRegistryDelegates(rows) as never;

describe("assertNameAvailable: reserved names", () => {
  it.each([UNSAFE, `  ${UNSAFE}  `])("refuses %j with VALIDATION_ERROR and the reserved-name message, without asking the database", async (name) => {
    const db = emptyRegistryDelegates();
    const res = await assertNameAvailable(db as never, { name, ...place });
    expect(res).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: message(UNSAFE) } });
    for (const delegate of Object.values(db)) expect(delegate.findMany).not.toHaveBeenCalled();
  });

  it("the look-alikes (lower case, other case, a suffix) are free names", async () => {
    for (const name of [UNSAFE.toLowerCase(), `${UNSAFE[0].toUpperCase()}${UNSAFE.slice(1)}`, `${UNSAFE}2`, `${UNSAFE}_1`]) {
      expect((await assertNameAvailable(fakeDb(), { name, ...place })).success, name).toBe(true);
    }
  });

  it("a rename of an asset that ALREADY has that name (created before the rule) to the same name is not refused; a rename TO it is", async () => {
    const row = { id: "e1", name: UNSAFE, tenantId: T, domainId: "d1", productId: null };
    const exclude = { kind: "entity" as const, id: "e1" };
    expect((await assertNameAvailable(fakeDb({ entity: [row] }), { name: UNSAFE, ...place, exclude })).success).toBe(true);
    // the same entity is called something else now: renaming it to the reserved name is a new use of the name
    expect(await assertNameAvailable(fakeDb({ entity: [] }), { name: UNSAFE, ...place, exclude })).toEqual({
      success: false, error: { code: "VALIDATION_ERROR", message: message(UNSAFE) },
    });
    // another asset's row of that name does not make the rename legal
    expect((await assertNameAvailable(fakeDb({ entity: [{ ...row, id: "e2" }] }), { name: UNSAFE, ...place, exclude })).success).toBe(false);
  });
});
