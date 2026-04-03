import { domainRouter } from "./routers/domain";
import { entityRouter } from "./routers/entity";
import { fieldRouter } from "./routers/field";

// oRPC routers are plain JavaScript objects
export const appRouter = {
  domain: domainRouter,
  entity: entityRouter,
  field: fieldRouter,
};

export type AppRouter = typeof appRouter;
