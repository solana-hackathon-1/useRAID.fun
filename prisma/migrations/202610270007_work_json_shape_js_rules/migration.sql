BEGIN;
-- 202610270003 mirrored the command schemas with btrim() (ASCII spaces only) and char_length() (code points), while the
-- zod schemas use JavaScript trim() (tabs, newlines, NBSP, Unicode spaces, BOM) and length (UTF-16 units). Redefine the
-- three validators on the exact JavaScript rules. CREATE OR REPLACE keeps the existing CHECK constraints bound and
-- does not re-scan rows already stored, so no data pre-check is needed for this change.
CREATE FUNCTION raid_js_trim(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT btrim(value, E' \t\n\u000b\u000c\r                 　﻿')
$$;
-- JavaScript string length: UTF-16 code units, so each code point above U+FFFF counts twice.
CREATE FUNCTION raid_utf16_length(value text) RETURNS integer LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT char_length(value) + char_length(regexp_replace(value, E'[^\\U00010000-\\U0010FFFF]', '', 'g'))
$$;
CREATE FUNCTION raid_js_text_ok(value text, maximum integer) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT raid_utf16_length(raid_js_trim(value)) BETWEEN 1 AND maximum
$$;
CREATE OR REPLACE FUNCTION raid_work_artifacts_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT CASE WHEN jsonb_typeof(value)='array' THEN
  jsonb_array_length(value) BETWEEN 1 AND 20
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(value) a
   WHERE jsonb_typeof(a)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(a) k) IS DISTINCT FROM ARRAY['immutableVersion','kind','ref']
    OR a->>'kind' NOT IN ('URL_SNAPSHOT','COMMIT','PRIVATE_ARTIFACT')
    OR jsonb_typeof(a->'ref')<>'string' OR NOT raid_js_text_ok(a->>'ref', 500)
    OR jsonb_typeof(a->'immutableVersion')<>'string' OR NOT raid_js_text_ok(a->>'immutableVersion', 200))
  AND (SELECT count(DISTINCT raid_js_trim(a->>'ref')||E'\n'||raid_js_trim(a->>'immutableVersion')) FROM jsonb_array_elements(value) a)=jsonb_array_length(value)
 ELSE false END
$$;
CREATE OR REPLACE FUNCTION raid_work_dependencies_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT CASE WHEN jsonb_typeof(value)='array' THEN
  jsonb_array_length(value)<=50
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value) d WHERE jsonb_typeof(d)<>'string' OR NOT raid_js_text_ok(d#>>'{}', 8000))
 ELSE false END
$$;
CREATE OR REPLACE FUNCTION raid_work_criteria_valid(value jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $$
 SELECT CASE WHEN jsonb_typeof(value)='array' THEN
  jsonb_array_length(value) BETWEEN 1 AND 50
  AND NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(value) c
   WHERE jsonb_typeof(c)<>'object'
    OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(c) k) IS DISTINCT FROM ARRAY['evidence','index','result']
    OR jsonb_typeof(c->'index')<>'number' OR (c->>'index') !~ '^([0-9]|[1-4][0-9])$'
    OR c->>'result' NOT IN ('MET','UNMET')
    OR NOT (jsonb_typeof(c->'evidence')='null' OR (jsonb_typeof(c->'evidence')='string' AND raid_js_text_ok(c->>'evidence', 2000))))
  AND (SELECT count(DISTINCT c->>'index') FROM jsonb_array_elements(value) c)=jsonb_array_length(value)
 ELSE false END
$$;
COMMIT;
