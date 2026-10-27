BEGIN;
-- Submission artifacts, dependencies and review criteria are strict version-one JSON (src/work-loop/submission-contracts.ts).
-- Mirror those shapes in the database so a direct writer cannot store what the command schema would refuse.
CREATE FUNCTION raid_work_artifacts_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(value)='array' AND jsonb_array_length(value) BETWEEN 1 AND 20
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(value) a
   WHERE jsonb_typeof(a)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['immutableVersion','kind','ref']
    OR a->>'kind' NOT IN ('URL_SNAPSHOT','COMMIT','PRIVATE_ARTIFACT')
    OR jsonb_typeof(a->'ref')<>'string' OR char_length(btrim(a->>'ref')) NOT BETWEEN 1 AND 500
    OR jsonb_typeof(a->'immutableVersion')<>'string' OR char_length(btrim(a->>'immutableVersion')) NOT BETWEEN 1 AND 200)
  AND (SELECT count(DISTINCT (a->>'ref')||E'\n'||(a->>'immutableVersion')) FROM jsonb_array_elements(value) a)=jsonb_array_length(value)
$$;
CREATE FUNCTION raid_work_dependencies_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(value)='array' AND jsonb_array_length(value)<=50
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value) d WHERE jsonb_typeof(d)<>'string' OR char_length(btrim(d#>>'{}')) NOT BETWEEN 1 AND 8000)
$$;
CREATE FUNCTION raid_work_criteria_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_typeof(value)='array' AND jsonb_array_length(value) BETWEEN 1 AND 50
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(value) c
   WHERE jsonb_typeof(c)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c) k) IS DISTINCT FROM ARRAY['evidence','index','result']
    OR jsonb_typeof(c->'index')<>'number' OR (c->>'index') !~ '^([0-9]|[1-4][0-9])$'
    OR c->>'result' NOT IN ('MET','UNMET')
    OR NOT (jsonb_typeof(c->'evidence')='null' OR (jsonb_typeof(c->'evidence')='string' AND char_length(btrim(c->>'evidence')) BETWEEN 1 AND 2000)))
  AND (SELECT count(DISTINCT c->>'index') FROM jsonb_array_elements(value) c)=jsonb_array_length(value)
$$;
ALTER TABLE "WorkSubmission" ADD CONSTRAINT "WorkSubmission_artifacts_shape_check" CHECK (raid_work_artifacts_valid("artifacts"));
ALTER TABLE "WorkSubmission" ADD CONSTRAINT "WorkSubmission_dependencies_shape_check" CHECK (raid_work_dependencies_valid("dependencies"));
ALTER TABLE "WorkReview" ADD CONSTRAINT "WorkReview_criteria_shape_check" CHECK (raid_work_criteria_valid("criteria"));
COMMIT;
