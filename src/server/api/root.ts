import { domainRouter } from "./routers/domain";
import { entityRouter } from "./routers/entity";
import { fieldRouter } from "./routers/field";
import { complianceRouter } from "./routers/compliance";
import { annotationRouter } from "./routers/annotation";
import { adminUsersRouter } from "./routers/admin/users";
import { adminDomainsRouter } from "./routers/admin/domains";
import { adminEmittersRouter } from "./routers/admin/emitters";
import { adminHealthRouter } from "./routers/admin/health";
import { adminClassificationsRouter } from "./routers/admin/classifications";

// oRPC routers are plain JavaScript objects
export const appRouter = {
  domain: domainRouter,
  entity: entityRouter,
  field: fieldRouter,
  compliance: complianceRouter,
  annotation: annotationRouter,
  admin: {
    users: adminUsersRouter,
    domains: adminDomainsRouter,
    emitters: adminEmittersRouter,
    health: adminHealthRouter,
    classifications: adminClassificationsRouter,
  },
};

export type AppRouter = typeof appRouter;
