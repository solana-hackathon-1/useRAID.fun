-- Read-only audit: stored Work rows that do NOT satisfy the current JSON shape rules
-- (migrations 202610270003 + 202610270007). The CHECK constraints hold for rows written
-- under the current rules, but CREATE OR REPLACE did not re-scan rows written earlier, and a
-- later restore that re-adds the constraints would fail on any row listed here.
-- Run before relying on a restore:  psql "$DATABASE_URL" -f scripts/audit-work-json-shape.sql
-- An empty result means every stored row conforms. Never prints row content.
SELECT 'WorkSubmission' AS "table", "id"::text AS "id", 'artifacts' AS "column"
  FROM "WorkSubmission" WHERE NOT raid_work_artifacts_valid("artifacts")
UNION ALL
SELECT 'WorkSubmission', "id"::text, 'dependencies'
  FROM "WorkSubmission" WHERE NOT raid_work_dependencies_valid("dependencies")
UNION ALL
SELECT 'WorkReview', "id"::text, 'criteria'
  FROM "WorkReview" WHERE NOT raid_work_criteria_valid("criteria")
ORDER BY 1, 2, 3;
