import { formatDisplayAmount, parseDisplayAmount } from '../contracts/assets';
import type { TermsSnapshot } from '../contracts/entities';
import { ProposeAmendmentInput } from '../work-loop/amendment-contracts';

type DeadlineKey = 'preparation' | 'submission' | 'review' | 'operationalClosure';
const DEADLINES: readonly [DeadlineKey, string][] = [
  ['preparation', 'Preparation due'],
  ['submission', 'Submission due'],
  ['review', 'Review due'],
  ['operationalClosure', 'Closes by'],
];
export interface ProposalForm {
  scope: string;
  /** One criterion per line. */
  criteria: string;
  /** Display-unit amounts, one per reward leg, in the leg's own verified decimals. */
  rewards: string[];
  /** `YYYY-MM-DDTHH:mm`, read as UTC. */
  deadlines: Record<DeadlineKey, string>;
  expiresAt: string;
}
export interface ChangeLine {
  kind: 'scope' | 'criteria' | 'reward' | 'deadline';
  label: string;
  before: string;
  after: string;
  direction?: 'UP' | 'DOWN';
}
const minute = (iso: string) => iso.slice(0, 16);
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const lines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
/** Short asset name for a reward leg; never invents a symbol the policy does not carry. */
export function assetLabel(policy: TermsSnapshot['rewards'][number]['policy']) {
  const asset = policy.assetId;
  return asset.kind === 'NATIVE_SOL' ? 'SOL' : 'token ' + asset.mint.slice(0, 6) + '…';
}
export const amountText = (leg: TermsSnapshot['rewards'][number]) =>
  formatDisplayAmount(leg.amount, leg.policy.verifiedDecimals) + ' ' + assetLabel(leg.policy);
/** The form prefilled with the current effective terms, so only deliberate edits become changes. */
export function formFrom(terms: TermsSnapshot): ProposalForm {
  return {
    scope: terms.scope,
    criteria: terms.acceptanceCriteria.join('\n'),
    rewards: terms.rewards.map((leg) =>
      formatDisplayAmount(leg.amount, leg.policy.verifiedDecimals),
    ),
    deadlines: {
      preparation: minute(terms.deadlines.preparation),
      submission: minute(terms.deadlines.submission),
      review: minute(terms.deadlines.review),
      operationalClosure: minute(terms.deadlines.operationalClosure),
    },
    expiresAt: '',
  };
}
/** What a proposed version changes against the current terms: only differing fields, exact amounts. */
export function describeChanges(before: TermsSnapshot, after: TermsSnapshot): ChangeLine[] {
  const out: ChangeLine[] = [];
  if (before.scope !== after.scope)
    out.push({ kind: 'scope', label: 'Scope', before: before.scope, after: after.scope });
  if (JSON.stringify(before.acceptanceCriteria) !== JSON.stringify(after.acceptanceCriteria))
    out.push({
      kind: 'criteria',
      label: 'Acceptance criteria',
      before: before.acceptanceCriteria.join('\n'),
      after: after.acceptanceCriteria.join('\n'),
    });
  after.rewards.forEach((leg, i) => {
    const was = before.rewards[i];
    if (was && was.amount !== leg.amount)
      out.push({
        kind: 'reward',
        label: after.rewards.length > 1 ? `Reward ${i + 1}` : 'Reward',
        before: amountText(was),
        after: amountText(leg),
        direction: BigInt(leg.amount) > BigInt(was.amount) ? 'UP' : 'DOWN',
      });
  });
  for (const [key, label] of DEADLINES)
    if (before.deadlines[key] !== after.deadlines[key])
      out.push({
        kind: 'deadline',
        label,
        before: before.deadlines[key],
        after: after.deadlines[key],
      });
  return out;
}
const utc = (value: string) => new Date(value + ':00.000Z');
export type BuiltProposal =
  | { ok: true; input: ReturnType<typeof ProposeAmendmentInput.parse> }
  | { ok: false; problem: string };
/**
 * Turns the form into the storage input, sending only deliberate changes. The server still decides everything
 * (authority, funding, ordering, state); these are the checks a person can fix before sending.
 */
export function buildProposal(
  engagementId: string,
  current: TermsSnapshot,
  form: ProposalForm,
  now: number,
): BuiltProposal {
  const changes: Record<string, unknown> = {};
  const scope = form.scope.trim();
  if (!scope) return { ok: false, problem: 'The scope cannot be empty.' };
  if (scope !== current.scope) changes.scope = scope;
  const criteria = lines(form.criteria);
  if (!criteria.length) return { ok: false, problem: 'Keep at least one acceptance criterion.' };
  if (JSON.stringify(criteria) !== JSON.stringify(current.acceptanceCriteria))
    changes.acceptanceCriteria = criteria;
  const amounts: string[] = [];
  for (const [i, leg] of current.rewards.entries()) {
    try {
      const amount = parseDisplayAmount(
        (form.rewards[i] ?? '').trim(),
        leg.policy.verifiedDecimals,
        10n ** 30n,
      );
      if (BigInt(amount) <= 0n) throw new Error('zero');
      amounts.push(amount);
    } catch {
      return {
        ok: false,
        problem: `Reward ${i + 1} must be a positive amount with at most ${leg.policy.verifiedDecimals} decimal places.`,
      };
    }
  }
  if (amounts.some((amount, i) => amount !== current.rewards[i].amount))
    changes.rewards = amounts.map((amount) => ({ amount }));
  const deadlines: Record<string, string> = {};
  for (const [key, label] of DEADLINES) {
    const value = form.deadlines[key];
    if (value === minute(current.deadlines[key])) continue;
    const at = MINUTE.test(value) ? utc(value) : null;
    if (!at || Number.isNaN(at.getTime()))
      return { ok: false, problem: `${label}: enter a UTC date and time.` };
    if (at.getTime() <= now) return { ok: false, problem: `${label} must be in the future.` };
    deadlines[key] = at.toISOString();
  }
  if (Object.keys(deadlines).length) changes.deadlines = deadlines;
  if (!Object.keys(changes).length)
    return { ok: false, problem: 'Change at least one term before proposing.' };
  const expires = MINUTE.test(form.expiresAt) ? utc(form.expiresAt) : null;
  if (!expires || Number.isNaN(expires.getTime()))
    return { ok: false, problem: 'Set when the proposal is valid until (UTC).' };
  if (expires.getTime() <= now)
    return { ok: false, problem: 'The proposal must stay valid until a time in the future.' };
  if (expires.getTime() > Date.parse(current.deadlines.submission))
    return {
      ok: false,
      problem: 'The proposal must expire before the current submission deadline.',
    };
  const parsed = ProposeAmendmentInput.safeParse({
    engagementId,
    changes,
    expiresAt: expires.toISOString(),
  });
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, problem: 'Check the form fields and try again.' };
}

/** A waiting proposal is lapsed once its expiry has passed; an unknown clock never claims a lapse. */
export const isLapsed = (expiresAt: string, now: number | null) =>
  now !== null && Date.parse(expiresAt) <= now;
/** Whether the person can answer a proposal now: hydrated, switched on, idle and not lapsed. */
export const canAnswer = (state: {
  ready: boolean;
  available: boolean;
  busy: boolean;
  lapsed: boolean;
}) => state.ready && state.available && !state.busy && !state.lapsed;
/** Identity of the terms a form was prefilled from: a new agreed version must start a fresh form. */
export const termsKey = (terms: TermsSnapshot) => JSON.stringify(terms);
