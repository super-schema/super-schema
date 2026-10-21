import { describe, it, expect } from "vitest";
import {
  parseTypeSpec,
  parseTypeSpecDocument,
  mapTypeSpecType,
} from "@/lib/compiler/typespec-parser";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import type { SuperSchemaModel } from "@/types/super-schema-model";

// ---------------------------------------------------------------------------
// Parser: Model Inheritance
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — model inheritance", () => {
  it("parses model extends", () => {
    const source = `
model Animal {
  name: string;
}

model Dog extends Animal {
  breed: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models).toHaveLength(2);
    expect(doc.models[0].name).toBe("Animal");
    expect(doc.models[0].extends).toBeUndefined();
    expect(doc.models[1].name).toBe("Dog");
    expect(doc.models[1].extends).toBe("Animal");
    expect(doc.models[1].fields).toHaveLength(1);
    expect(doc.models[1].fields[0].name).toBe("breed");
  });

  it("parses model with @doc and extends", () => {
    const source = `
@doc("A base entity")
model BaseEntity {
  @key
  id: string;
}

@doc("A user entity")
model User extends BaseEntity {
  name: string;
  email?: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models).toHaveLength(2);
    expect(doc.models[0].doc).toBe("A base entity");
    expect(doc.models[1].doc).toBe("A user entity");
    expect(doc.models[1].extends).toBe("BaseEntity");
    expect(doc.models[1].fields).toHaveLength(2);
  });

  it("parses inline field decorators on the same line as the field", () => {
    const source = `
model TaxDetails {
  @secret tax_id: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models[0].fields).toHaveLength(1);
    expect(doc.models[0].fields[0]).toMatchObject({
      name: "tax_id",
      type: "string",
      decorators: { secret: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Parser: Model Spread
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — model spread", () => {
  it("parses spread syntax", () => {
    const source = `
model Timestamped {
  createdAt: utcDateTime;
  updatedAt: utcDateTime;
}

model User {
  ...Timestamped;
  id: string;
  name: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models).toHaveLength(2);
    expect(doc.models[1].name).toBe("User");
    expect(doc.models[1].spreadFrom).toEqual(["Timestamped"]);
    expect(doc.models[1].fields).toHaveLength(2); // only own fields
  });

  it("parses multiple spreads", () => {
    const source = `
model User {
  ...Timestamped;
  ...Auditable;
  id: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models[0].spreadFrom).toEqual(["Timestamped", "Auditable"]);
  });
});

// ---------------------------------------------------------------------------
// Parser: Shared Enums
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — enums", () => {
  it("parses standalone enum", () => {
    const source = `
enum Status {
  Active,
  Inactive,
  Suspended,
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.enums).toHaveLength(1);
    expect(doc.enums[0].name).toBe("Status");
    expect(doc.enums[0].values).toEqual(["Active", "Inactive", "Suspended"]);
  });

  it("parses enum with @doc", () => {
    const source = `
@doc("User account status")
enum AccountStatus {
  Active,
  Locked,
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.enums[0].doc).toBe("User account status");
  });

  it("parses enum with value assignments", () => {
    const source = `
enum Color {
  Red: "red",
  Blue: "blue",
  Green: "green",
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.enums[0].values).toEqual(["Red", "Blue", "Green"]);
  });
});

// ---------------------------------------------------------------------------
// Parser: Custom Scalars
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — custom scalars", () => {
  it("parses scalar definition", () => {
    const source = `scalar EmailAddress extends string;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.scalars).toHaveLength(1);
    expect(doc.scalars[0].name).toBe("EmailAddress");
    expect(doc.scalars[0].baseType).toBe("string");
  });

  it("parses scalar with preceding @doc", () => {
    const source = `
@doc("A monetary amount")
scalar Money extends decimal;
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.scalars[0].doc).toBe("A monetary amount");
    expect(doc.scalars[0].baseType).toBe("decimal");
  });

  it("parses scalar decorators used by shared domain types", () => {
    const source = `
@doc("ISO 3166-1 alpha-2 country code")
@pattern("^[A-Z]{2}$")
scalar CountryCode extends string;
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.scalars[0]).toMatchObject({
      name: "CountryCode",
      baseType: "string",
      doc: "ISO 3166-1 alpha-2 country code",
      pattern: "^[A-Z]{2}$",
    });
  });
});

// ---------------------------------------------------------------------------
// Parser: Unions
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — unions", () => {
  it("parses inline union", () => {
    const source = `union Pet = Cat | Dog | Fish;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.unions).toHaveLength(1);
    expect(doc.unions[0].name).toBe("Pet");
    expect(doc.unions[0].memberTypes).toEqual(["Cat", "Dog", "Fish"]);
  });

  it("parses block union", () => {
    const source = `
union Animal {
  Cat,
  Dog,
  Fish,
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.unions[0].memberTypes).toEqual(["Cat", "Dog", "Fish"]);
  });
});

// ---------------------------------------------------------------------------
// Parser: Aliases
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — aliases", () => {
  it("parses alias declaration", () => {
    const source = `alias UserId = string;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.aliases).toHaveLength(1);
    expect(doc.aliases[0].name).toBe("UserId");
    expect(doc.aliases[0].type).toBe("string");
  });

  it("parses complex alias", () => {
    const source = `alias StringMap = Record<string, string>;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.aliases[0].type).toBe("Record<string, string>");
  });
});

// ---------------------------------------------------------------------------
// Parser: Namespaces
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — namespaces", () => {
  it("parses namespace with semicolon", () => {
    const source = `
namespace MyService;

model User {
  id: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.namespace).toBe("MyService");
    expect(doc.models).toHaveLength(1);
  });

  it("parses namespace with braces", () => {
    const source = `
namespace MyService {

model User {
  id: string;
}

}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.namespace).toBe("MyService");
    expect(doc.models).toHaveLength(1);
  });

  it("parses dotted namespace", () => {
    const source = `namespace My.Service.Api;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.namespace).toBe("My.Service.Api");
  });
});

// ---------------------------------------------------------------------------
// Parser: Discriminator
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — discriminator", () => {
  it("parses @discriminator on model", () => {
    const source = `
@discriminator("kind")
model Shape {
  kind: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models[0].discriminator).toBe("kind");
  });
});

// ---------------------------------------------------------------------------
// Parser: Operations and Interfaces
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — operations", () => {
  it("parses standalone operation", () => {
    const source = `op getUser(@path id: string): User;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.operations).toHaveLength(1);
    expect(doc.operations[0].name).toBe("getUser");
    expect(doc.operations[0].returnType).toBe("User");
    expect(doc.operations[0].params).toHaveLength(1);
    expect(doc.operations[0].params[0].name).toBe("id");
    expect(doc.operations[0].params[0].location).toBe("path");
  });

  it("parses interface with operations", () => {
    const source = `
interface UserService {
  @get
  @route("/users/{id}")
  op getUser(@path id: string): User;

  @post
  @route("/users")
  op createUser(@body user: User): User;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.interfaces).toHaveLength(1);
    expect(doc.interfaces[0].name).toBe("UserService");
    expect(doc.interfaces[0].operations).toHaveLength(2);

    const getOp = doc.interfaces[0].operations[0];
    expect(getOp.name).toBe("getUser");
    expect(getOp.httpMethod).toBe("GET");
    expect(getOp.httpPath).toBe("/users/{id}");

    const createOp = doc.interfaces[0].operations[1];
    expect(createOp.name).toBe("createUser");
    expect(createOp.httpMethod).toBe("POST");
    expect(createOp.httpPath).toBe("/users");
  });
});

// ---------------------------------------------------------------------------
// Parser: Default values, never, internal, const, using, import
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — batch 4 constructs", () => {
  it("parses field with default value", () => {
    const source = `
model Config {
  retryCount: int32 = 3;
  name: string = "default";
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models[0].fields[0].defaultValue).toBe("3");
    expect(doc.models[0].fields[1].defaultValue).toBe('"default"');
  });

  it("skips never type fields", () => {
    const source = `
model User {
  id: string;
  _internal: never;
  name: string;
}
`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.models[0].fields).toHaveLength(2);
    expect(doc.models[0].fields.map((f) => f.name)).toEqual(["id", "name"]);
  });

  it("parses const declarations", () => {
    const source = `const MAX_RETRIES = 5;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.consts).toHaveLength(1);
    expect(doc.consts[0].name).toBe("MAX_RETRIES");
    expect(doc.consts[0].value).toBe("5");
  });

  it("parses using statements", () => {
    const source = `using TypeSpec.Http;`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.usings).toEqual(["TypeSpec.Http"]);
  });

  it("parses import statements", () => {
    const source = `import "@typespec/http";`;
    const doc = parseTypeSpecDocument(source);
    expect(doc.imports).toEqual(["@typespec/http"]);
  });
});

// ---------------------------------------------------------------------------
// Parser: Full document with multiple constructs
// ---------------------------------------------------------------------------

describe("parseTypeSpecDocument — complex document", () => {
  it("parses a complete TypeSpec document", () => {
    const source = `
import "@typespec/http";
using TypeSpec.Http;

namespace PetStore;

scalar Email extends string;

enum PetStatus {
  Available,
  Pending,
  Sold,
}

union PetOrError = Pet | Error;

alias PetId = string;

@doc("A pet in the store")
model Pet {
  @key
  id: string;
  name: string;
  status: PetStatus;
}

model Error {
  code: int32;
  message: string;
}

interface PetService {
  @get
  @route("/pets/{id}")
  op getPet(@path id: string): Pet;
}
`;
    const doc = parseTypeSpecDocument(source);

    expect(doc.namespace).toBe("PetStore");
    expect(doc.imports).toEqual(["@typespec/http"]);
    expect(doc.usings).toEqual(["TypeSpec.Http"]);
    expect(doc.scalars).toHaveLength(1);
    expect(doc.enums).toHaveLength(1);
    expect(doc.unions).toHaveLength(1);
    expect(doc.aliases).toHaveLength(1);
    expect(doc.models).toHaveLength(2);
    expect(doc.interfaces).toHaveLength(1);

    expect(doc.models[0].name).toBe("Pet");
    expect(doc.models[0].doc).toBe("A pet in the store");
    expect(doc.models[0].fields).toHaveLength(3);
    expect(doc.models[0].fields[0].isKey).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generator: Inheritance, Spread, Enums, Scalars, Unions, Aliases, Namespaces
// ---------------------------------------------------------------------------

describe("generateTypeSpec — new constructs", () => {
  function makeBaseModel(overrides: Partial<SuperSchemaModel> = {}): SuperSchemaModel {
    return {
      entity: {
        id: "test-1",
        name: "TestEntity",
        domain: "TestDomain",
        domainId: "dom-1",
        description: "",
        status: "DRAFT",
        version: 1,
        metadata: {},
        ...overrides.entity,
      },
      fields: overrides.fields ?? [],
      relationships: [],
      ...overrides,
    };
  }

  it("generates model with extends clause", () => {
    const model = makeBaseModel({
      entity: {
        id: "test-1",
        name: "Dog",
        domain: "Animals",
        domainId: "dom-1",
        description: "",
        status: "DRAFT",
        version: 1,
        metadata: {},
        parentEntityName: "Animal",
      },
      fields: [
        {
          name: "breed",
          type: "string",
          nullable: false,
          isKey: false,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 0,
        },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("model Dog extends Animal {");
    expect(output).toContain("breed: string;");
  });

  it("generates model with spread syntax", () => {
    const model = makeBaseModel({
      entity: {
        id: "test-1",
        name: "User",
        domain: "Core",
        domainId: "dom-1",
        description: "",
        status: "DRAFT",
        version: 1,
        metadata: {},
        spreadFrom: ["Timestamped", "Auditable"],
      },
      fields: [
        {
          name: "id",
          type: "string",
          nullable: false,
          isKey: true,
          description: "",
          aliases: [],
          decorators: {},
          sortOrder: 0,
        },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("...Timestamped;");
    expect(output).toContain("...Auditable;");
  });

  it("generates shared enum definitions", () => {
    const model = makeBaseModel({
      sharedEnums: [
        { name: "Status", values: ["Active", "Inactive"], description: "Account status" },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain('@doc("Account status")');
    expect(output).toContain("enum Status {");
    expect(output).toContain("  Active,");
    expect(output).toContain("  Inactive,");
  });

  it("generates custom scalar definitions", () => {
    const model = makeBaseModel({
      customScalars: [
        { name: "Email", baseType: "string", description: "Email address" },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("scalar Email extends string;");
  });

  it("generates union definitions (block form, even for short ones: `union X = A | B;` is not TypeSpec)", () => {
    const model = makeBaseModel({
      unionTypes: [
        { name: "Pet", memberTypes: ["Cat", "Dog"] },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("union Pet {\n  Cat,\n  Dog,\n}");
  });

  it("generates union definitions (block for many members)", () => {
    const model = makeBaseModel({
      unionTypes: [
        { name: "Animal", memberTypes: ["Cat", "Dog", "Fish", "Bird"] },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("union Animal {");
    expect(output).toContain("  Cat,");
  });

  it("generates alias definitions", () => {
    const model = makeBaseModel({
      aliases: [{ name: "UserId", type: "string" }],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("alias UserId = string;");
  });

  it("generates namespace declaration", () => {
    const model = makeBaseModel({
      namespace: "MyService.Api",
    });

    const output = generateTypeSpec(model);
    expect(output).toContain("namespace MyService.Api;");
  });

  it("generates interface with operations", () => {
    const model = makeBaseModel({
      interfaces: [
        {
          name: "UserService",
          description: "User management API",
          operations: [
            {
              name: "getUser",
              httpMethod: "GET",
              httpPath: "/users/{id}",
              parameters: [
                { name: "id", type: "string", location: "path", required: true },
              ],
              responses: [{ statusCode: 200, type: "User" }],
            },
          ],
        },
      ],
    });

    const output = generateTypeSpec(model);
    expect(output).toContain('interface UserService {');
    expect(output).toContain('@route("/users/{id}")');
    expect(output).toContain("@get");
    expect(output).toContain("op getUser(@path id: string): User;");
  });
});

// ---------------------------------------------------------------------------
// Parser: backward compat — parseTypeSpec still works
// ---------------------------------------------------------------------------

describe("parseTypeSpec — backward compatibility", () => {
  it("returns first model from multi-model document", () => {
    const source = `
model A {
  id: string;
}
model B {
  name: string;
}
`;
    const result = parseTypeSpec(source);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("A");
  });

  it("returns null for empty input", () => {
    expect(parseTypeSpec("")).toBeNull();
    expect(parseTypeSpec("   ")).toBeNull();
  });

  it("returns null for no model", () => {
    expect(parseTypeSpec("just text")).toBeNull();
    expect(parseTypeSpec("model Name")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapTypeSpecType — union syntax
// ---------------------------------------------------------------------------

describe("mapTypeSpecType — extended", () => {
  it("handles inline union type expressions", () => {
    const result = mapTypeSpecType("Cat | Dog");
    expect(result.type).toBe("Cat | Dog");
  });
});
