import { domainRouter } from "./routers/domain";
import { entityRouter } from "./routers/entity";

// oRPC routers are plain JavaScript objects
export const appRouter = {
  domain: domainRouter,
  entity: entityRouter,
};

export type AppRouter = typeof appRouter;
