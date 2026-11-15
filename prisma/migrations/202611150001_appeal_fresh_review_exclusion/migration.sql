-- Fresh review after an upheld skill-assessment appeal (#490, follow-up to #357; DEC-2026-11-13-12 (c), DEC-2026-11-14-11).
-- An upheld appeal records every original evaluator in "freshReviewExcludedAccountIds"; the fresh review must be done by
-- someone else. This migration only ENFORCES that exclusion: three additive BEFORE INSERT triggers refuse an excluded
-- account as the evaluator of a new review appointment, review version or assessment decision on an assessment whose
-- appeal was upheld. It adds no table or column, replaces no existing function or trigger, edits no row, grants no rank
-- and touches no money. It does not start or perform the fresh review itself (undecided; see docs).
-- Scope: the assessment family named by the appealed version (every submission that has a version in the family, and the
-- family's decisions). A brand-new submission that has no assessment version yet is not covered.
-- Locking: the guard takes the per-person/skill assessment lock (class 12022) that appeal decisions, assessment decisions
-- and acceptance already take, always AFTER any case lock (12020) its own statement holds, so an appeal decision and a
-- concurrent appointment/review/decision serialize and neither can miss the other.
BEGIN;
CREATE FUNCTION raid_skill_appeal_fresh_review_guard_v1() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE families uuid[]; scope RECORD;
BEGIN
 IF TG_TABLE_NAME='PracticeAssessmentDecision' THEN
  families:=ARRAY[NEW."assessmentId"];
 ELSE
  families:=ARRAY(SELECT DISTINCT v."assessmentId" FROM "SkillAssessmentVersion" v WHERE v."submissionId"=NEW."submissionId");
 END IF;
 IF COALESCE(cardinality(families),0)=0 THEN RETURN NEW; END IF;
 FOR scope IN SELECT DISTINCT a."participantId",a."skillId" FROM "SkillAssessment" a WHERE a."id"=ANY(families) ORDER BY 1,2 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(scope."participantId"::text||':'||scope."skillId",12022));
 END LOOP;
 IF EXISTS(
  SELECT 1 FROM "SkillAssessmentAppealDecision" d
  JOIN "SkillAssessmentAppeal" p ON p."id"=d."appealId"
  JOIN "SkillAssessmentVersion" v ON v."id"=p."assessmentVersionId"
  WHERE d."outcome"='UPHELD' AND v."assessmentId"=ANY(families) AND NEW."evaluatorAccountId"=ANY(d."freshReviewExcludedAccountIds")
 ) THEN
  RAISE EXCEPTION 'An evaluator excluded from the fresh review by an upheld appeal cannot act on this assessment' USING ERRCODE='23000';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER skill_appeal_fresh_review_assignment_v1 BEFORE INSERT ON "PracticeTrialReviewAssignment" FOR EACH ROW EXECUTE FUNCTION raid_skill_appeal_fresh_review_guard_v1();
CREATE TRIGGER skill_appeal_fresh_review_review_v1 BEFORE INSERT ON "PracticeAssessmentReviewVersion" FOR EACH ROW EXECUTE FUNCTION raid_skill_appeal_fresh_review_guard_v1();
CREATE TRIGGER skill_appeal_fresh_review_decision_v1 BEFORE INSERT ON "PracticeAssessmentDecision" FOR EACH ROW EXECUTE FUNCTION raid_skill_appeal_fresh_review_guard_v1();
COMMIT;
