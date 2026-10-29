'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import {
  createWorkClient,
  describeWorkFailure,
  newRequestKey,
  type FailureKind,
} from '../work-http/workspace-client';

type Client = Pick<ReturnType<typeof createWorkClient>, 'recordConsent' | 'acceptRaid'>;
interface AcceptInput {
  slotId: string;
  termsVersionId: string;
  termsDigest: string;
  offerId?: string;
}
export type AcceptOutcome =
  { kind: 'DONE' } | { kind: 'BUSY' } | { kind: FailureKind; message: string };
/**
 * Consent to the shown terms digest, then accept. Each step keeps its own request key across an unconfirmed failure,
 * so pressing the button again retries the same commands instead of duplicating either; a definite answer drops only
 * the key of the step that gave it. Accept is never sent unless consent was just recorded or replayed.
 */
export function createAcceptRunner(client: Client, newKey: () => string = newRequestKey) {
  let consentKey: string | null = null;
  let acceptKey: string | null = null;
  let inFlight = false;
  return {
    async accept(input: AcceptInput): Promise<AcceptOutcome> {
      if (inFlight) return { kind: 'BUSY' };
      inFlight = true;
      let step: 'CONSENT' | 'ACCEPT' = 'CONSENT';
      try {
        consentKey ??= newKey();
        await client.recordConsent(
          {
            slotId: input.slotId,
            termsVersionId: input.termsVersionId,
            termsDigest: input.termsDigest,
          },
          consentKey,
        );
        step = 'ACCEPT';
        acceptKey ??= newKey();
        await client.acceptRaid(
          {
            slotId: input.slotId,
            termsVersionId: input.termsVersionId,
            ...(input.offerId ? { offerId: input.offerId } : {}),
          },
          acceptKey,
        );
        consentKey = acceptKey = null;
        return { kind: 'DONE' };
      } catch (error) {
        const described = describeWorkFailure(error);
        if (described.kind !== 'RETRY_SAME_REQUEST') {
          if (step === 'CONSENT') consentKey = null;
          else acceptKey = null;
        }
        return described;
      } finally {
        inFlight = false;
      }
    },
  };
}
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
/**
 * Accepting is binding, so the person first confirms they read the terms shown on this page. The page states no
 * eligibility: the server rechecks the session, skills, capacity, funding and offer when the person acts.
 */
export function AcceptRaid({
  slotId,
  termsVersionId,
  termsDigest,
  offerId,
  client,
}: {
  slotId: string;
  termsVersionId: string;
  termsDigest: string;
  offerId?: string;
  client?: Client;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const runner = useRef<ReturnType<typeof createAcceptRunner> | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [outcome, setOutcome] = useState<AcceptOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    runner.current ??= createAcceptRunner(client ?? createWorkClient());
    setBusy(true);
    const result = await runner.current.accept({ slotId, termsVersionId, termsDigest, offerId });
    setBusy(false);
    if (result.kind !== 'BUSY') setOutcome(result);
  }
  return (
    <form
      name="accept-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (agreed) void submit();
      }}
    >
      <p>
        {offerId
          ? 'The Founder has offered you this Raid. Accepting commits you to the terms on this page.'
          : 'Accepting commits you to the terms on this page.'}{' '}
        Eligibility is checked by the server when you accept, never from this page.
      </p>
      {outcome?.kind === 'DONE' ? (
        <p role="status">
          Raid accepted. <a href="/raider/work">Go to My Raid</a> to start work.
        </p>
      ) : (
        <>
          {outcome && outcome.kind !== 'BUSY' && (
            <p role="alert">
              {outcome.message}
              {outcome.kind === 'SIGN_IN' && (
                <>
                  {' '}
                  <a href="/creator/account">Sign in</a>
                </>
              )}
              {outcome.kind === 'RETRY_SAME_REQUEST' && ' Press the same button again to retry.'}
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={agreed}
              disabled={!ready || busy}
              onChange={(event) => setAgreed(event.target.checked)}
            />{' '}
            I have read the terms above and agree to them.
          </label>
          <button className="button" type="submit" disabled={!ready || !agreed || busy}>
            {busy ? 'Accepting…' : 'Accept this Raid'}
          </button>
        </>
      )}
      <noscript>
        <p>Accepting needs JavaScript. Turn it on to accept.</p>
      </noscript>
    </form>
  );
}
