-- Additive: DEC-2026-11-13-13 / DEC-2026-11-14-12 (#331) applicant-consented, per-application evidence snapshot.
-- No existing row or applied migration is rewritten. Requires 202610260003_work_admission (RaidApplication) and
-- 202610260002_engagement_capacity (raid_engagement_immutable).
BEGIN;

-- 1. The snapshot is the consent record: the applicant chose these skills for THIS application and the values as read at
--    that moment are frozen. It is bound to the exact application, slot, terms version and participant, and is immutable.
--    At most one per application (a withdrawn snapshot is not replaced: withdrawal is final for that application).
CREATE TABLE "ApplicantEvidenceSnapshot" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "applicationId" uuid NOT NULL,
 "slotId" uuid NOT NULL,
 "termsVersionId" uuid NOT NULL,
 "participantId" uuid NOT NULL,
 "skills" jsonb NOT NULL,
 "takenAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "ApplicantEvidenceSnapshot_application_key" UNIQUE ("applicationId"),
 CONSTRAINT "ApplicantEvidenceSnapshot_owner_key" UNIQUE ("id","participantId"),
 CONSTRAINT "ApplicantEvidenceSnapshot_application_fkey" FOREIGN KEY ("applicationId","slotId","participantId","termsVersionId") REFERENCES "RaidApplication"("id","slotId","participantId","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "ApplicantEvidenceSnapshot_participant_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "ApplicantEvidenceSnapshot_skills_check" CHECK (jsonb_typeof("skills")='array' AND jsonb_array_length("skills") BETWEEN 1 AND 50)
);
CREATE INDEX "ApplicantEvidenceSnapshot_participantId_idx" ON "ApplicantEvidenceSnapshot"("participantId");
CREATE TRIGGER "ApplicantEvidenceSnapshot_immutable" BEFORE UPDATE OR DELETE ON "ApplicantEvidenceSnapshot" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

-- A snapshot can only be taken while its application is still pending. The application row is locked FOR SHARE so a
-- concurrent withdrawal/close (which updates it) and this insert serialize: whichever commits first wins.
CREATE FUNCTION raid_applicant_evidence_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE app_state text;
BEGIN
 SELECT "state" INTO app_state FROM "RaidApplication" WHERE "id"=NEW."applicationId" FOR SHARE;
 IF app_state IS DISTINCT FROM 'SUBMITTED' THEN
  RAISE EXCEPTION 'Evidence can only be shared with a pending application' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "ApplicantEvidenceSnapshot_guard" BEFORE INSERT ON "ApplicantEvidenceSnapshot" FOR EACH ROW EXECUTE FUNCTION raid_applicant_evidence_snapshot_guard();

-- 2. Withdrawal is an append-only row beside the immutable snapshot, by the snapshot's own participant, at most once.
--    The reviewer view drops the snapshot once this row exists; content already seen cannot be recalled.
CREATE TABLE "ApplicantEvidenceSnapshotWithdrawal" (
 "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 "snapshotId" uuid NOT NULL,
 "participantId" uuid NOT NULL,
 "withdrawnAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "ApplicantEvidenceSnapshotWithdrawal_snapshot_key" UNIQUE ("snapshotId"),
 CONSTRAINT "ApplicantEvidenceSnapshotWithdrawal_owner_fkey" FOREIGN KEY ("snapshotId","participantId") REFERENCES "ApplicantEvidenceSnapshot"("id","participantId") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "ApplicantEvidenceSnapshotWithdrawal_participant_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX "ApplicantEvidenceSnapshotWithdrawal_participantId_idx" ON "ApplicantEvidenceSnapshotWithdrawal"("participantId");
CREATE TRIGGER "ApplicantEvidenceSnapshotWithdrawal_immutable" BEFORE UPDATE OR DELETE ON "ApplicantEvidenceSnapshotWithdrawal" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();

COMMIT;
