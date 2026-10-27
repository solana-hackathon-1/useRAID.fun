'use client';
import { useRef, useState, useSyncExternalStore } from 'react';
import {
  createWorkClient,
  describeWorkFailure,
  newRequestKey,
  type FailureKind,
} from '../work-http/workspace-client';

type Client = Pick<ReturnType<typeof createWorkClient>, 'submitApplication'>;
interface ApplyInput {
  slotId: string;
  termsVersionId: string;
  evidenceRefs: string[];
}
export type ApplyOutcome =
  { kind: 'DONE' } | { kind: 'BUSY' } | { kind: FailureKind; message: string };
/**
 * One request key per unchanged intent, kept across an unconfirmed failure so pressing the button again retries the
 * same command instead of creating a second application. A definite answer drops the key.
 */
export function createApplyRunner(client: Client, newKey: () => string = newRequestKey) {
  let key: string | null = null;
  let inFlight = false;
  return {
    async apply(input: ApplyInput): Promise<ApplyOutcome> {
      if (inFlight) return { kind: 'BUSY' };
      inFlight = true;
      key ??= newKey();
      try {
        await client.submitApplication(input, key);
        key = null;
        return { kind: 'DONE' };
      } catch (error) {
        const described = describeWorkFailure(error);
        if (described.kind !== 'RETRY_SAME_REQUEST') key = null;
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
/** Apply is nonbinding: it records interest only. The server rechecks everything when the person later acts. */
export function ApplyToRaid({
  slotId,
  termsVersionId,
  client,
}: {
  slotId: string;
  termsVersionId: string;
  client?: Client;
}) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const runner = useRef<ReturnType<typeof createApplyRunner> | null>(null);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    runner.current ??= createApplyRunner(client ?? createWorkClient());
    setBusy(true);
    const result = await runner.current.apply({ slotId, termsVersionId, evidenceRefs: [] });
    setBusy(false);
    if (result.kind !== 'BUSY') setOutcome(result);
  }
  return (
    <form
      name="apply-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
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
