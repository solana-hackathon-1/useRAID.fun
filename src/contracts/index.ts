// T002 RED-only scaffold: lets the behavior tests execute before implementation.
import { z } from 'zod';
export const AccountId = z.string();
export const ParticipantId = z.string();
export const GuildId = z.string();
export const TermsVersionId = z.string();
export const ParticipantSchema = z.object({}).passthrough();
export const PublicGuildSchema = z.object({}).passthrough();
export const AssetIdSchema = z.object({}).passthrough();
export const AssetPolicySnapshotSchema = z.object({}).passthrough();
export const AmountSchema = z.unknown();
export const TermsSnapshotSchema = z.object({}).passthrough();
export const EngagementSchema = z.object({}).passthrough();
export const CommandContextSchema = z.object({}).passthrough();
export const API_VERSION = 'unimplemented';
export const STATES = { engagement: ['UNIMPLEMENTED'] };
export const StateSchema = Object.fromEntries(
  ['engagement', 'listing', 'claim', 'access', 'dispute', 'transaction', 'run', 'offer'].map(
    (k) => [k, z.string()],
  ),
);
export const COMMANDS = {
  CommitEngagement: { owner: '', authority: [], guards: [], reference: '' },
  StartEngagement: { owner: '', authority: [], guards: [], reference: '' },
  ClaimAsset: { owner: '', authority: [], guards: [], reference: '' },
  DecideDispute: { owner: '', authority: [], guards: [], reference: '' },
};
export function assetKey(_value: unknown): string {
  throw new Error('Asset identity not implemented');
}
export function parseDisplayAmount(_value: unknown, _decimals: number, _maximum: bigint): string {
  throw new Error('Exact amount parsing not implemented');
}
export function formatDisplayAmount(_value: unknown, _decimals: number): string {
  throw new Error('Exact amount formatting not implemented');
}
export function consumesCapacity(_value: unknown): boolean {
  throw new Error('Capacity classification not implemented');
}
export function planCapacityLocks(_value: unknown): unknown {
  throw new Error('Lock ordering not implemented');
}
export function createErrorEnvelope(
  _code: string,
  _requestId: string,
): { body: { error: { retryable: boolean } } } {
  throw new Error('Error envelope not implemented');
}
