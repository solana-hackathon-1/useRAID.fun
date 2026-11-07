import type { GuildCommand } from '../guild-profiles/guild-storage-contracts';
import { activateGuild } from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { config } from './config';
import { db } from './db';

/**
 * Exact-string flag, default off and never in demo mode (DEC-2026-11-07-02). It gates only new activations: an
 * original receipt still replays, and the approver is re-proven on every replay.
 */
export function guildActivationConfiguration() {
  const writesAvailable = !config.demo && process.env.GUILD_ACTIVATION_ENABLED === 'true';
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
 * Approves one account: allowlisted only. That an applicant never approves their own Guild is enforced by
 * `activateGuild` itself, whatever this answers. Any allowlisted operator can create a Founder, so this is NOT the
 * T010 project-control trust root, and an activation moves no funds.
 */
const authorizeActivation = async (_tx: unknown, actor: { accountId: string }) =>
  activationOperators().has(actor.accountId);
export const activateGuildAsOperator = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) =>
    activateGuild(tx, command, {
      allowNewWrites: guildActivationConfiguration().writesAvailable,
      authorizeActivation,
    }),
  );
