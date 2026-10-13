-- Explicit composite ownership FK dependency, matching root wallet-link migration.
CREATE UNIQUE INDEX "Participant_id_accountId_key" ON "Participant"("id","accountId");
