import type { GuildCommand } from '../guild-profiles/guild-storage-contracts';
import { activateGuild } from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { config } from './config';
import { db } from './db';

/**
 * Simulated funds only (DEC-2026-11-07-02): activation fails closed while any switch that starts or authorizes real
 * money movement is on. Each is on only for the exact string `true`, as the flags themselves read it.
 */
const REAL_FUNDS_FLAGS = [
  'LAUNCH_ENABLED',
  'PAYOUT_ENABLED',
  'X_TRACKING_V2_SETTLEMENT_ENABLED',
  'LIVE_COLLECTION_APPROVED',
] as const;
const realFundsEnabled = () =>
  REAL_FUNDS_FLAGS.some((name) => Reflect.get(process.env, name) === 'true');
/**
 * Exact-string flag, default off, never in demo mode and never beside a real-funds switch (DEC-2026-11-07-02). It
 * gates only new activations: an original receipt still replays, and the approver is re-proven on every replay.
 */
export function guildActivationConfiguration() {
  const writesAvailable =
    !config.demo && process.env.GUILD_ACTIVATION_ENABLED === 'true' && !realFundsEnabled();
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
/**
 * The dedicated activation allowlist. It is deliberately separate from `RAID_WORK_OPERATOR_ACCOUNT_IDS` (Raid-listing
 * authority): creating a Guild and listing work are different powers. Empty or unset denies everyone. Matching is exact
 * on the account id, nothing else is consulted, and the list is read on every call so a removal takes effect at once.
 */
function activationOperators() {
  return new Set(
    (process.env.GUILD_ACTIVATION_OPERATOR_ACCOUNT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
/**
 * Approves one account: allowlisted only, and never while a real-funds switch is on (replays included). That an applicant never approves their own Guild is enforced by
 * `activateGuild` itself, whatever this answers. Any allowlisted operator can create a Founder, so this is NOT the
 * T010 project-control trust root, and an activation moves no funds.
 */
const authorizeActivation = async (_tx: unknown, actor: { accountId: string }) =>
  !realFundsEnabled() && activationOperators().has(actor.accountId);
export const activateGuildAsOperator = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) =>
    activateGuild(tx, command, {
      allowNewWrites: guildActivationConfiguration().writesAvailable,
      authorizeActivation,
    }),
  );
