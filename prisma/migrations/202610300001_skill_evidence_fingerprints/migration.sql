-- Additive (#56 T014): advisory duplicate-evidence fingerprints for private skill-claim references (blueprint 07.5/09.7).
-- No existing row, constraint or guard is changed. Claims saved before this migration have no fingerprints until their
-- next claim version is saved, so they can never be flagged; nothing is backfilled or restricted automatically.
BEGIN;
CREATE TABLE "SkillEvidenceFingerprint" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "skillClaimVersionId" UUID NOT NULL,
 "fingerprintVersion" TEXT NOT NULL,
 "fingerprint" TEXT NOT NULL,
 "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 CONSTRAINT "SkillEvidenceFingerprint_pkey" PRIMARY KEY("id"),
 CONSTRAINT "SkillEvidenceFingerprint_version_check" CHECK("fingerprintVersion" ~ '^v[0-9]{1,3}$'),
 CONSTRAINT "SkillEvidenceFingerprint_digest_check" CHECK("fingerprint" ~ '^[0-9a-f]{64}$'),
 CONSTRAINT "SkillEvidenceFingerprint_version_fkey" FOREIGN KEY("skillClaimVersionId") REFERENCES "SkillClaimVersion"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "SkillEvidenceFingerprint_version_digest_key" ON "SkillEvidenceFingerprint"("skillClaimVersionId","fingerprintVersion","fingerprint");
CREATE INDEX "SkillEvidenceFingerprint_digest_idx" ON "SkillEvidenceFingerprint"("fingerprintVersion","fingerprint");
CREATE TRIGGER skill_evidence_fingerprint_guard_v1 BEFORE UPDATE OR DELETE ON "SkillEvidenceFingerprint" FOR EACH ROW EXECUTE FUNCTION raid_append_only_guard_v1();
COMMIT;
