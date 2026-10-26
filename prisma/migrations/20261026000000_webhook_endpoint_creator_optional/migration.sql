-- webhook_endpoints.createdBy becomes optional (access-control Task 6, KD-024).
--
-- The REST API key is a SERVICE principal, not a row of "users": an endpoint it creates has no creator, and the foreign key to "users" refused the
-- insert (the endpoint could not be created through the REST API at all). The column keeps its foreign key (a creator, when there is one, is a
-- real user, and deleting that user is still refused while an endpoint names it: ON DELETE RESTRICT is unchanged). Existing rows keep their creator.
ALTER TABLE "webhook_endpoints" ALTER COLUMN "createdBy" DROP NOT NULL;
