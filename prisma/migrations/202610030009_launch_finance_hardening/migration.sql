ALTER TABLE "TokenLaunch" ADD COLUMN "rentReserveLamports" BIGINT NOT NULL DEFAULT 0;

CREATE INDEX "FinancialTx_launchId_kind_roundId_idx" ON "FinancialTx"("launchId", "kind", "roundId");

UPDATE "FeeClaim" fc
SET "roundId" = ft."roundId"
FROM "FinancialTx" ft
JOIN "RewardRound" r ON r.id = ft."roundId"
WHERE fc.signature = ft.signature
  AND fc.source = 'failed-network-cost'
  AND fc."roundId" IS NULL
  AND ft.kind IN ('PAYOUT', 'PLATFORM')
  AND r.status = 'READY';
