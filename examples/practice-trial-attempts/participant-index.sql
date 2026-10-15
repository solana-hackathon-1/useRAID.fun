-- Explicit minimal-host composite identity dependency; Root migration202610090003 owns it.
CREATE UNIQUE INDEX "Participant_id_accountId_key" ON "Participant"("id","accountId");
