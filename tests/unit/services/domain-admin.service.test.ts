import { describe, it, expect, beforeEach } from "vitest";
import {
  getDomainsAdmin,
  getDomainAdminById,
  createDomainAdmin,
  updateDomainAdmin,
  deleteDomainAdmin,
  applyPolicyTemplate,
  removeInheritance,
  _resetDomainAdminStore,
  _setEntityCount,
  type DomainRecord,
} from "@/services/domain-admin.service";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: null as unknown as ServiceContext["prisma"],
};

describe("Domain Admin Service", () => {
  beforeEach(() => {
    _resetDomainAdminStore();
  });

  describe("createDomainAdmin", () => {
    it("creates domain with policy template", async () => {
      const result = await createDomainAdmin(
        {
          name: "Finance",
          description: "Financial data",
          policyTemplate: {
            classification: "SENSITIVE",
            retention: "7 years",
          },
        },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Finance");
        expect(result.data.policyTemplate).toEqual({
          classification: "SENSITIVE",
          retention: "7 years",
        });
      }
    });

    it("creates domain without policy template", async () => {
      const result = await createDomainAdmin(
        { name: "General" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.policyTemplate).toBeNull();
      }
    });

    it("rejects duplicate domain name (case-insensitive)", async () => {
      await createDomainAdmin({ name: "Finance" }, adminCtx);
      const result = await createDomainAdmin({ name: "finance" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await createDomainAdmin({ name: "Test" }, viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("rejects empty name", async () => {
      const result = await createDomainAdmin({ name: "" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("updateDomainAdmin", () => {
    it("updates name, description, and policy template", async () => {
      const created = await createDomainAdmin({ name: "Original" }, adminCtx);
      expect(created.success).toBe(true);
      if (!created.success) return;

      const result = await updateDomainAdmin(
        {
          id: created.data.id,
          name: "Updated",
          description: "New description",
          policyTemplate: { classification: "PII" },
        },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Updated");
        expect(result.data.description).toBe("New description");
        expect(result.data.policyTemplate).toEqual({ classification: "PII" });
      }
    });

    it("rejects duplicate name on update", async () => {
      await createDomainAdmin({ name: "First" }, adminCtx);
      const second = await createDomainAdmin({ name: "Second" }, adminCtx);
      expect(second.success).toBe(true);
      if (!second.success) return;

      const result = await updateDomainAdmin(
        { id: second.data.id, name: "First" },
        adminCtx
      );
      expect(result.success).toBe(false);
    });
  });

  describe("deleteDomainAdmin", () => {
    it("deletes a domain with no entities", async () => {
      const created = await createDomainAdmin({ name: "Empty" }, adminCtx);
      expect(created.success).toBe(true);
      if (!created.success) return;

      const result = await deleteDomainAdmin(created.data.id, adminCtx);
      expect(result.success).toBe(true);
    });

    it("blocks deletion when entities exist", async () => {
      const created = await createDomainAdmin({ name: "HasEntities" }, adminCtx);
      expect(created.success).toBe(true);
      if (!created.success) return;

      _setEntityCount(created.data.id, 5);

      const result = await deleteDomainAdmin(created.data.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("CONFLICT");
        expect(result.error.message).toContain("5 entities");
      }
    });
  });

  describe("getDomainsAdmin", () => {
    it("returns domains with entity counts and template status", async () => {
      await createDomainAdmin(
        { name: "WithTemplate", policyTemplate: { classification: "PII" } },
        adminCtx
      );
      await createDomainAdmin({ name: "NoTemplate" }, adminCtx);

      const result = await getDomainsAdmin(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        const withTemplate = result.data.find((d) => d.name === "WithTemplate");
        const noTemplate = result.data.find((d) => d.name === "NoTemplate");
        expect(withTemplate?.policyTemplateStatus).toBe("Configured");
        expect(noTemplate?.policyTemplateStatus).toBe("No template");
      }
    });
  });

  describe("applyPolicyTemplate", () => {
    it("merges template values into field decorators", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "Finance",
        description: "",
        policyTemplate: {
          classification: "SENSITIVE",
          retention: "7 years",
        },
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators, inherited } = applyPolicyTemplate(domain, {});

      expect(decorators.classification).toEqual({ level: "SENSITIVE" });
      expect((decorators.policy as Record<string, unknown>)?.retention).toBe("7 years");
      expect(inherited).not.toBeNull();
      expect(inherited!.keys).toContain("classification");
      expect(inherited!.keys).toContain("retention");
      expect(inherited!.domainName).toBe("Finance");
    });

    it("does not override existing field values", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "Finance",
        description: "",
        policyTemplate: { classification: "SENSITIVE" },
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators, inherited } = applyPolicyTemplate(domain, {
        classification: { level: "PII" },
      });

      expect((decorators.classification as Record<string, unknown>)?.level).toBe("PII");
      expect(inherited).toBeNull(); // no keys were inherited
    });

    it("returns original decorators when no template exists", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "General",
        description: "",
        policyTemplate: null,
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators, inherited } = applyPolicyTemplate(domain, { custom: "value" });

      expect(decorators).toEqual({ custom: "value" });
      expect(inherited).toBeNull();
    });

    it("sets _inherited metadata correctly", () => {
      const domain: DomainRecord = {
        id: "dom-1",
        name: "Finance",
        description: "",
        policyTemplate: { classification: "PII", retention: "3 years" },
        isSystem: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const { decorators } = applyPolicyTemplate(domain, {});
      const inherited = decorators._inherited as { domainId: string; keys: string[] };

      expect(inherited.domainId).toBe("dom-1");
      expect(inherited.keys).toContain("classification");
      expect(inherited.keys).toContain("retention");
    });
  });

  describe("removeInheritance", () => {
    it("removes a key from inherited metadata", () => {
      const decorators = {
        classification: { level: "PII" },
        _inherited: {
          domainId: "dom-1",
          domainName: "Finance",
          keys: ["classification", "retention"],
        },
      };

      const result = removeInheritance(decorators, "classification");
      const inherited = result._inherited as { keys: string[] };
      expect(inherited.keys).toEqual(["retention"]);
    });

    it("removes _inherited entirely when no keys remain", () => {
      const decorators = {
        classification: { level: "PII" },
        _inherited: {
          domainId: "dom-1",
          domainName: "Finance",
          keys: ["classification"],
        },
      };

      const result = removeInheritance(decorators, "classification");
      expect(result._inherited).toBeUndefined();
    });

    it("returns unchanged decorators when no _inherited exists", () => {
      const decorators = { classification: { level: "PII" } };
      const result = removeInheritance(decorators, "classification");
      expect(result).toEqual(decorators);
    });
  });
});
