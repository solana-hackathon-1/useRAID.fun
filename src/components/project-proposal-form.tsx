'use client';
import { useEffect, useRef, useState } from 'react';
import {
  GuildProjectProposalHttpInputSchema,
  GuildProjectProposalHttpStateSchema,
  GuildProjectProposalHttpSavedSchema,
  type GuildProjectProposalHttpState,
} from '../guild-profiles/project-proposal-http-contracts';
import { GuildDraftHttpStateSchema } from '../guild-profiles/http-contracts';
import { assetKey } from '../contracts/assets';
import type { z } from 'zod';
type Input = z.infer<typeof GuildProjectProposalHttpInputSchema>;
export interface ProjectProposalTransport {
  save(id: string, input: Input, key: string): Promise<Response>;
  readProposal(id: string): Promise<Response>;
  readDraft(id: string): Promise<Response>;
}
const transport: ProjectProposalTransport = {
  save: (id, input, key) =>
    fetch('/api/v1/guild-drafts/' + encodeURIComponent(id) + '/project-proposal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    }),
  readProposal: (id) =>
    fetch('/api/v1/guild-drafts/' + encodeURIComponent(id) + '/project-proposal', {
      cache: 'no-store',
    }),
  readDraft: (id) => fetch('/api/v1/guild-drafts/' + encodeURIComponent(id), { cache: 'no-store' }),
};
export function ProjectProposalForm({
  state: initial,
  draftRevision: initialDraftRevision,
  api = transport,
}: {
  state: GuildProjectProposalHttpState;
  draftRevision: number;
  api?: ProjectProposalTransport;
}) {
  const [state, setState] = useState(initial),
    [draftRevision, setDraftRevision] = useState(initialDraftRevision);
  const [fields, setFields] = useState({
    networkIdentity: initial.proposal?.candidateToken.networkIdentity ?? '',
    mint: initial.proposal?.candidateToken.mint ?? '',
    tokenProgram: initial.proposal?.candidateToken.tokenProgram ?? '',
    references: initial.proposal?.publicEvidenceRefs.join('\n') ?? '',
  });
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [needsRevision, setNeedsRevision] = useState(false),
    [message, setMessage] = useState(''),
    [saved, setSaved] = useState('');
  const pending = useRef<{ key: string; input: Input; unconfirmed: boolean } | null>(null),
    inFlight = useRef(false),
    alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) alert.current?.focus();
  }, [message]);
  function update(field: keyof typeof fields, value: string) {
    setFields((old) => ({ ...old, [field]: value }));
    setMessage('');
    setSaved('');
  }
  function unknown() {
    if (pending.current) pending.current.unconfirmed = true;
    setUncertain(true);
    setMessage(
      'The save could not be confirmed. Keep this page open. Retry with the same proposal.',
    );
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    if (!pending.current) {
      const parsed = GuildProjectProposalHttpInputSchema.safeParse({
        expectedDraftRevision: draftRevision,
        expectedProposalRevision: state.proposal?.revision ?? 0,
        candidateToken: {
          chain: 'SOLANA',
          kind: 'TOKEN',
          networkIdentity: fields.networkIdentity,
          mint: fields.mint,
          tokenProgram: fields.tokenProgram,
        },
        publicEvidenceRefs: fields.references
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      });
      if (!parsed.success) {
        setMessage(
          'Enter the full network identity, valid token mint and token program addresses, and one to five different HTTPS reference URLs without credentials.',
        );
        return;
      }
      pending.current = { key: crypto.randomUUID(), input: parsed.data, unconfirmed: false };
    }
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    setSaved('');
    try {
      const attempt = pending.current,
        response = await api.save(state.guildDraftId, attempt.input, attempt.key),
        body = await response.json();
      if (!response.ok) {
        const code = body?.error?.code;
        if (response.status >= 500 || response.status < 400) {
          unknown();
          return;
        }
        if (attempt.unconfirmed && [401, 403, 429].includes(response.status)) {
          setUncertain(true);
          setMessage(
            response.status === 429
              ? 'Too many requests. Wait, then retry with the same proposal.'
              : 'Sign in or resolve account access, then retry with the same proposal. Keep this page open.',
          );
          return;
        }
        if (code === 'IDEMPOTENCY_KEY_REUSED') {
          unknown();
          return;
        }
        pending.current = null;
        setUncertain(false);
        if (code === 'REVISION_CHANGED') {
          setNeedsRevision(true);
          setMessage(
            'Saved details changed. Reload the saved revision, then review your preserved proposal.',
          );
        } else
          setMessage(
            response.status === 401
              ? 'Sign in again to save your proposal.'
              : response.status === 403
                ? 'Saving is not permitted for this account.'
                : response.status === 429
                  ? 'Too many requests. Wait, then save your proposal again.'
                  : 'Check your fields and try again.',
          );
        return;
      }
      const parsed = GuildProjectProposalHttpSavedSchema.safeParse(body);
      if (!parsed.success) throw Error('Invalid private acknowledgment');
      const value = parsed.data,
        p = value.proposal;
      if (
        value.guildDraftId !== state.guildDraftId ||
        p.revision !== attempt.input.expectedProposalRevision + 1 ||
        p.draftRevision !== attempt.input.expectedDraftRevision ||
        assetKey(p.candidateToken) !== assetKey(attempt.input.candidateToken) ||
        JSON.stringify(p.publicEvidenceRefs) !== JSON.stringify(attempt.input.publicEvidenceRefs)
      )
        throw Error('Wrong command response');
      setState({
        version: 'v1',
        guildDraftId: value.guildDraftId,
        proposal: p,
        writesAvailable: value.writesAvailable,
        unavailableReason: value.unavailableReason,
      });
      setFields({
        networkIdentity: p.candidateToken.networkIdentity,
        mint: p.candidateToken.mint,
        tokenProgram: p.candidateToken.tokenProgram,
        references: p.publicEvidenceRefs.join('\n'),
      });
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved('Proposal saved.');
    } catch {
      unknown();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const draftResponse = await api.readDraft(state.guildDraftId),
        draft = GuildDraftHttpStateSchema.safeParse(await draftResponse.json());
      const response = await api.readProposal(state.guildDraftId),
        parsed = GuildProjectProposalHttpStateSchema.safeParse(await response.json());
      if (
        !draftResponse.ok ||
        !draft.success ||
        draft.data.draft.id.toLowerCase() !== state.guildDraftId ||
        !response.ok ||
        !parsed.success ||
        parsed.data.guildDraftId !== state.guildDraftId
      )
        throw Error('Read failed');
      setState(parsed.data);
      setDraftRevision(draft.data.draft.revision);
      pending.current = null;
      setUncertain(false);
      setNeedsRevision(false);
      setSaved(
        'Saved revision reloaded. Your proposal is preserved. Review the saved details before saving.',
      );
    } catch {
      setMessage('Saved details could not be loaded. Your proposal is preserved.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="orientation-layout">
      <section className="orientation-card">
        <h2>Your private proposal</h2>
        <p>This proposal stays private.</p>
        <p>Founder control has not been verified.</p>
        <p>
          This is existing-project preparation. Saving does not recognize the token or publish a
          Guild.
        </p>
        {!state.writesAvailable && (
          <p role="status">
            Saving proposals is currently unavailable. Existing saved details remain readable.
          </p>
        )}
        <form onSubmit={submit} noValidate aria-busy={busy}>
          <fieldset
            className="orientation-fields"
            disabled={busy || uncertain || !state.writesAvailable}
          >
            <legend className="visually-hidden">Private existing-project fields</legend>
            <label>
              Claimed network identity
              <input
                aria-label="Claimed network identity"
                maxLength={200}
                value={fields.networkIdentity}
                onChange={(event) => update('networkIdentity', event.target.value)}
              />
              <span className="orientation-hint">
                Use the full network or genesis identity. This field does not verify the network.
              </span>
            </label>
            <label>
              Token mint
              <input
                aria-label="Token mint"
                maxLength={44}
                value={fields.mint}
                onChange={(event) => update('mint', event.target.value)}
              />
            </label>
            <label>
              Token program
              <input
                aria-label="Token program"
                maxLength={44}
                value={fields.tokenProgram}
                onChange={(event) => update('tokenProgram', event.target.value)}
              />
            </label>
            <label>
              Supporting reference URLs
              <textarea
                aria-label="Supporting reference URLs"
                rows={5}
                maxLength={10244}
                value={fields.references}
                onChange={(event) => update('references', event.target.value)}
              />
              <span className="orientation-hint">
                One to five different HTTPS URLs, one per line. References have not been verified.
              </span>
            </label>
          </fieldset>
          {message && (
            <p role="alert" tabIndex={-1} ref={alert}>
              {message}
            </p>
          )}
          {saved && <p role="status">{saved}</p>}
          <div className="orientation-actions">
            <button
              className="button"
              type="submit"
              disabled={busy || needsRevision || (!state.writesAvailable && !uncertain)}
            >
              {busy ? 'Saving…' : uncertain ? 'Retry save' : 'Save private proposal'}
            </button>
            {needsRevision && (
              <button className="button secondary" type="button" disabled={busy} onClick={reload}>
                Reload saved revision
              </button>
            )}
          </div>
        </form>
      </section>
      <section className="orientation-card">
        <h2>Saved proposal</h2>
        {state.proposal ? (
          <>
            <p>Pending verification</p>
            <p>Saved proposal revision {state.proposal.revision}</p>
            <dl>
              <dt>Network</dt>
              <dd>{state.proposal.candidateToken.networkIdentity}</dd>
              <dt>Mint</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>{state.proposal.candidateToken.mint}</dd>
              <dt>Token program</dt>
              <dd style={{ overflowWrap: 'anywhere' }}>
                {state.proposal.candidateToken.tokenProgram}
              </dd>
            </dl>
            <p>Saved supporting references</p>
            <ul>
              {state.proposal.publicEvidenceRefs.map((reference) => (
                <li key={reference} style={{ overflowWrap: 'anywhere' }}>
                  {reference}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No proposal has been saved.</p>
        )}
        <p>
          Project control requires an approved attestation and supporting evidence before
          verification.
        </p>
      </section>
    </div>
  );
}
