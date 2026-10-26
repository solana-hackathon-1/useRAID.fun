BEGIN;
-- A simulated reward reservation: one immutable record per slot, bound to the exact reward vector it covers.
-- It records host-declared synthetic coverage only; it is not a balance, escrow or claim on live funds.
CREATE TABLE "WorkSimulatedReservation" (
 "slotId" uuid PRIMARY KEY,
 "termsVersionId" uuid NOT NULL,
 "vectorDigest" text NOT NULL CHECK ("vectorDigest" ~ '^[0-9a-f]{64}$'),
 "legs" jsonb NOT NULL CHECK (jsonb_typeof("legs")='array' AND jsonb_array_length("legs") BETWEEN 1 AND 10),
 "createdAt" timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT "WorkSimulatedReservation_slot_fkey" FOREIGN KEY ("slotId","termsVersionId") REFERENCES "RaidSlot"("id","termsVersionId") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE TRIGGER "WorkSimulatedReservation_immutable" BEFORE UPDATE OR DELETE ON "WorkSimulatedReservation" FOR EACH ROW EXECUTE FUNCTION raid_engagement_immutable();
COMMIT;
