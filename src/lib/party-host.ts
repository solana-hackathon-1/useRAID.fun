import type { WorkActor, WorkCommand } from '../work-loop/contracts';
import {
  createParty,
  proposePartyRoster,
  readPartyProposal,
  recordPartyMemberConsent,
} from '../parties/party-storage';
import { runCommandTransaction } from './command-receipts-adapter';
import { partyRosterWritesEnabled } from './config';
import { db } from './db';

/** The switch is read per request so a flip applies at once; it gates new writes only, never replays or reads. */
const host = () => ({ allowNewWrites: partyRosterWritesEnabled() });
export const createPartyFromHost = (command: WorkCommand) =>
  runCommandTransaction(db, (tx) => createParty(tx, command, host()));
export const proposePartyRosterFromHost = (command: WorkCommand) =>
  runCommandTransaction(db, (tx) => proposePartyRoster(tx, command, host()));
export const recordPartyConsentFromHost = (command: WorkCommand) =>
  runCommandTransaction(db, (tx) => recordPartyMemberConsent(tx, command, host()));
export const readPartyProposalFromHost = (actor: WorkActor, proposalId: string) =>
  runCommandTransaction(db, (tx) => readPartyProposal(tx, actor, { proposalId }));
