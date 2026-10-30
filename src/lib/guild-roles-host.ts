import type { GuildCommand } from '../guild-profiles/guild-storage-contracts';
import {
  grantGuildRole,
  proposeOwnershipTransfer,
  respondOwnershipTransfer,
  revokeGuildRole,
} from '../guild-profiles/guild-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { config } from './config';
import { db } from './db';

/**
 * Exact-string flag, default off. It gates new grants, proposals and responses. Revocation never waits for it: storage
 * keeps taking authority away possible during an incident, so switching writes off can never block undoing access.
 */
export function guildRolesWriteConfiguration() {
  const writesAvailable = !config.demo && process.env.GUILD_ROLE_MANAGEMENT_ENABLED === 'true';
  return { writesAvailable, unavailableReason: writesAvailable ? null : ('DISABLED' as const) };
}
const host = () => ({ allowNewWrites: guildRolesWriteConfiguration().writesAvailable });
export const grantRole = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) => grantGuildRole(tx, command, host()));
export const revokeRole = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) => revokeGuildRole(tx, command, host()));
export const proposeTransfer = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) => proposeOwnershipTransfer(tx, command, host()));
/**
 * The ownership policy hook answers closed: the recorded re-verification of project control it stands for (O11/G10,
 * T010) does not exist yet, so no acceptance can move the Founder over HTTP. Declining and withdrawing do not consult
 * it. A host with that process replaces this one function.
 */
export const respondTransfer = (command: GuildCommand) =>
  runCommandTransaction(db, (tx) =>
    respondOwnershipTransfer(tx, command, {
      ...host(),
      authorizeOwnershipTransfer: async () => false,
    }),
  );
