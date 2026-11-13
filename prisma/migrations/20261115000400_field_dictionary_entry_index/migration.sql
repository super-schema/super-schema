-- Fields are looked up by the dictionary entry they were created from (usage counts, drift, the SET NULL on entry delete).
CREATE INDEX "fields_dictionaryEntryId_idx" ON "fields"("dictionaryEntryId");
