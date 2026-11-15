BEGIN;
-- #501: PostgreSQL fires same-event BEFORE ROW triggers in name order. "RaidSlot_funding_distinct" sorted before
-- "RaidSlot_guard", so a raw UPDATE OF "fundingRef" took the per-reference advisory lock before the WorkListing row lock
-- (raid_slot_guard), the reverse of the application order (listing, then funding reference). Rename the funding trigger so
-- it fires after the guard. Only the name changes: same function, events and policy (SQLSTATE 23514), same lock key.
ALTER TRIGGER "RaidSlot_funding_distinct" ON "RaidSlot" RENAME TO "RaidSlot_guard_funding_distinct";
COMMIT;
