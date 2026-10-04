-- Rewards preserve evidence and signed economic identities through retries.
CREATE FUNCTION launch_balance_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'Launch balance entries are append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER launch_balance_entry_immutable BEFORE UPDATE OR DELETE ON "LaunchBalanceEntry"
FOR EACH ROW EXECUTE FUNCTION launch_balance_immutable();

CREATE FUNCTION launch_payout_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."launchId",NEW."raidId",NEW."asset",NEW."network",NEW."walletAddress",NEW."xId",NEW."units")
     IS DISTINCT FROM ROW(OLD."launchId",OLD."raidId",OLD."asset",OLD."network",OLD."walletAddress",OLD."xId",OLD."units") THEN
    RAISE EXCEPTION 'Launch payout identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER launch_payout_identity_immutable BEFORE UPDATE ON "LaunchCampaignPayout"
FOR EACH ROW EXECUTE FUNCTION launch_payout_identity_immutable();

CREATE FUNCTION launch_budget_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."launchId",NEW."raidId",NEW."asset",NEW."network",NEW."reservedUnits")
     IS DISTINCT FROM ROW(OLD."launchId",OLD."raidId",OLD."asset",OLD."network",OLD."reservedUnits") THEN
    RAISE EXCEPTION 'Reserved launch budget is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER launch_budget_identity_immutable BEFORE UPDATE ON "LaunchCampaignBudget"
FOR EACH ROW EXECUTE FUNCTION launch_budget_identity_immutable();

CREATE FUNCTION launch_economics_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD."provider"='METEORA' AND ROW(NEW."mint",NEW."provider",NEW."network",NEW."userId",NEW."creatorAddress",NEW."feeAddress",NEW."configuration",NEW."poolConfigAddress",NEW."feeVaultAddress",NEW."poolAddress")
      IS DISTINCT FROM ROW(OLD."mint",OLD."provider",OLD."network",OLD."userId",OLD."creatorAddress",OLD."feeAddress",OLD."configuration",OLD."poolConfigAddress",OLD."feeVaultAddress",OLD."poolAddress") THEN
    RAISE EXCEPTION 'Meteora launch economics are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER launch_economics_immutable BEFORE UPDATE ON "TokenLaunch"
FOR EACH ROW EXECUTE FUNCTION launch_economics_immutable();
