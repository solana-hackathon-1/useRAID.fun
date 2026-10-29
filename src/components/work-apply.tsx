'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import {
  createWorkClient,
  describeWorkFailure,
  newRequestKey,
  WorkClientError,
  type FailureKind,
} from '../work-http/workspace-client';

type Client = Pick<ReturnType<typeof createWorkClient>, 'submitApplication'>;
interface ApplyInput {
  slotId: string;
  termsVersionId: string;
  evidenceRefs: string[];
}
export type ApplyOutcome =
  { kind: 'DONE' } | { kind: 'BUSY' } | { kind: FailureKind | 'GONE'; message: string };
/** Definite answers that this Raid can no longer be applied to from this page: the slot was taken or it closed. */
const GONE_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'NO_LONGER_OPEN']);
/**
 * One request key per unchanged intent, kept across an unconfirmed failure so pressing the button again retries the
 * same command instead of creating a second application. A definite answer drops the key.
 */
export function createApplyRunner(client: Client, newKey: () => string = newRequestKey) {
  let key: string | null = null;
  let keyedInput = '';
  let inFlight = false;
  return {
    async apply(input: ApplyInput): Promise<ApplyOutcome> {
      if (inFlight) return { kind: 'BUSY' };
      inFlight = true;
      // A key belongs to one unchanged intent: changed input must never reuse it (IDEMPOTENCY_KEY_REUSED).
      const intent = JSON.stringify(input);
      if (intent !== keyedInput) key = null;
      keyedInput = intent;
      key ??= newKey();
      try {
        await client.submitApplication(input, key);
        key = null;
        return { kind: 'DONE' };
      } catch (error) {
        if (error instanceof WorkClientError && GONE_CODES.has(error.code)) {
          key = null;
          return { kind: 'GONE', message: 'This Raid is no longer available.' };
        }
        const described = describeWorkFailure(error);
        if (described.kind !== 'RETRY_SAME_REQUEST') key = null;
        return described;
      } finally {
        inFlight = false;
      }
    },
  };
}
/** Busy stays set while another press is ignored; it clears only with the real result of the first request. */
export async function submitApply(
  runner: { apply(input: ApplyInput): Promise<ApplyOutcome> },
  input: ApplyInput,
  ui: { setBusy(busy: boolean): void; setOutcome(outcome: ApplyOutcome): void },
) {
  ui.setBusy(true);
  const result = await runner.apply(input);
  if (result.kind === 'BUSY') return;
  ui.setBusy(false);
  ui.setOutcome(result);
}
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
/** The apply form for one state. A "no longer available" answer replaces the stale form and its button. */
export function ApplyView({
  outcome,
  busy,
  ready,
  signInHref,
  onSubmit,
}: {
  outcome: ApplyOutcome | null;
  busy: boolean;
  ready: boolean;
  signInHref: string;
  onSubmit(): void;
}) {
  return (
    <form
      name="apply-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p>
        An application is not a commitment. The Founder may offer you this Raid; taking it is a
        separate step. Eligibility is checked by the server when you act, never from this page.
      </p>
      {outcome?.kind === 'DONE' ? (
        <p role="status">
          Application sent. <a href="/raider/work">See it in My Raid</a>.
        </p>
      ) : outcome?.kind === 'GONE' ? (
        <p role="status">
          {outcome.message} <a href="/raids">See live Raids</a>.
        </p>
      ) : (
        <>
          {outcome && outcome.kind !== 'BUSY' && (
            <p role="alert">
              {outcome.message}
              {outcome.kind === 'SIGN_IN' && (
                <>
                  {' '}
                  <a href={signInHref}>Sign in</a>
                </>
              )}
              {outcome.kind === 'RETRY_SAME_REQUEST' && ' Press the same button again to retry.'}
            </p>
          )}
          <button className="button" type="submit" disabled={!ready || busy}>
            {busy ? 'Applying…' : 'Apply to this Raid'}
          </button>
        </>
      )}
      <noscript>
        <p>Applying needs JavaScript. Turn it on to apply.</p>
      </noscript>
    </form>
  );
}
/** Apply is nonbinding: it records interest only. The server rechecks everything when the person later acts. */
export function ApplyToRaid({
  slotId,
  termsVersionId,
  applied = false,
  signInHref = '/creator/account',
  client,
}: {
  slotId: string;
  termsVersionId: string;
  /** The viewer already has a submitted application for these terms; it is shown instead of the form. */
  applied?: boolean;
  /** Where the sign-in link goes, carrying this page as the return path. */
  signInHref?: string;
  client?: Client;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const runner = useRef<ReturnType<typeof createApplyRunner> | null>(null);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    runner.current ??= createApplyRunner(client ?? createWorkClient());
    await submitApply(
      runner.current,
      { slotId, termsVersionId, evidenceRefs: [] },
      { setBusy, setOutcome },
    );
  }
  if (applied)
    return (
      <p role="status">
        You already applied to this Raid. <a href="/raider/work">See it in My Raid</a>.
      </p>
    );
  return (
    <ApplyView
      outcome={outcome}
      busy={busy}
      ready={ready}
      signInHref={signInHref}
      onSubmit={() => void submit()}
    />
  );
}
