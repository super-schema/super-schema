import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The Compose stack (.docker/docker-compose.yml): which database the app opens, the order the services start in, and what the host can reach.
const REPO = path.resolve(__dirname, "../../..");
const COMPOSE_TEXT = readFileSync(path.join(REPO, ".docker", "docker-compose.yml"), "utf8");

type ComposeService = {
  build?: { context?: string; dockerfile?: string; target?: string };
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  ports?: string[];
  healthcheck?: { test?: string[] };
};
const services = (parse(COMPOSE_TEXT) as { services: Record<string, ComposeService> }).services;

describe("docker-compose: the app runs on the compose Postgres", () => {
  it("sets DB_PROVIDER=postgresql for the app (unset means embedded PGlite, which starts empty inside the container)", () => {
    expect(services.app.environment?.DB_PROVIDER).toBe("postgresql");
    expect(services.app.environment?.DATABASE_URL).toMatch(/@db:5432\//);
  });

  it("runs the migrations and the built-in traits (npm run db:deploy) against that database before the app starts", () => {
    expect(services.migrate?.build?.target).toBe("migrate");
    expect(services.migrate?.environment?.DB_PROVIDER).toBe("postgresql");
    expect(services.migrate?.depends_on?.db?.condition).toBe("service_healthy");
    expect(services.app.depends_on?.migrate?.condition).toBe("service_completed_successfully");
  });

  it("takes the Postgres password from the environment, required, and uses that value in DATABASE_URL", () => {
    expect(services.db.environment?.POSTGRES_PASSWORD).toMatch(/^\$\{POSTGRES_PASSWORD:\?/);
    for (const service of [services.app, services.migrate]) {
      expect(service?.environment?.DATABASE_URL).toMatch(/:\$\{POSTGRES_PASSWORD:\?[^}]*\}@db:5432\//);
    }
    expect(COMPOSE_TEXT).not.toMatch(/superschema:password@|POSTGRES_PASSWORD: password/);
  });

  it("publishes every port on the loopback interface only: the app and the database are not reachable from another machine", () => {
    for (const [name, service] of Object.entries(services)) {
      for (const port of service.ports ?? []) expect(port, `${name} publishes ${port}`).toMatch(/^127\.0\.0\.1:/);
    }
    expect(services.app.ports).toEqual(["127.0.0.1:3000:3000"]);
    expect(services.db.ports).toEqual(["127.0.0.1:5432:5432"]);
  });

  it("checks the database over TCP: the initialisation server of the image answers on its socket before TCP is open, so a socket check passes early", () => {
    expect(services.db.healthcheck?.test?.join(" ")).toMatch(/pg_isready -h 127\.0\.0\.1 /);
  });
});
