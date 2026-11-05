'use client';
import { useEffect, useRef, useState } from 'react';
import {
  createManageRunner,
  fetchGuildManageApi,
  manageMessage,
  parseProfileResult,
  parseUpdateResult,
  type GuildManageApi,
  type ManageOutcome,
} from '../guild-profiles/guild-manage-client';
import {
  DraftGuildUpdateInputSchema,
  EditGuildProfileInputSchema,
  ManagedGuildSchema,
  type ManagedGuild,
  type ManagedGuildUpdate,
} from '../guild-profiles/guild-storage-contracts';

/** Moves focus to a new error message so keyboard and screen-reader users hear it. */
function useAlert(message: string) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return ref;
}
const failureText = (
  outcome: Exclude<ManageOutcome<unknown>, { kind: 'DONE' } | { kind: 'BUSY' }>,
) => outcome.message;

export function GuildProfileEditor({
  guild: initial,
  writesAvailable,
  api = fetchGuildManageApi,
}: {
  guild: ManagedGuild;
  writesAvailable: boolean;
  api?: GuildManageApi;
}) {
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial.name),
    [description, setDescription] = useState(initial.description);
  const [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [message, setMessage] = useState(''),
    [notice, setNotice] = useState('');
  const runner = useRef(createManageRunner());
  const alert = useAlert(message);
  const changed = name.trim() !== saved.name || description.trim() !== saved.description;
  function edit(field: 'name' | 'description', value: string) {
    if (field === 'name') setName(value);
    else setDescription(value);
    setMessage('');
    setNotice('');
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Only changed fields are sent, so a delegate limited to one field is never asked for the other.
    const profile = {
      ...(name.trim() !== saved.name ? { name } : {}),
      ...(description.trim() !== saved.description ? { description } : {}),
    };
    const input = {
      guildId: saved.id,
      expectedRevision: saved.revision,
      profile,
    };
    const checked = EditGuildProfileInputSchema.safeParse(input);
    if (!checked.success) {
      setMessage(manageMessage('INVALID'));
      return;
    }
    setBusy(true);
    setMessage('');
    setNotice('');
    const outcome = await runner.current.run(
      checked.data,
      (key) => api.editProfile(checked.data, key),
      (body) => parseProfileResult(body, checked.data),
    );
    setBusy(false);
    if (outcome.kind === 'BUSY') return;
    if (outcome.kind === 'DONE') {
      // The Founder id never leaves the server view for non-managers; keep the redacted shape in local state.
      setSaved({ ...outcome.value, founderAccountId: saved.founderAccountId });
      setName(outcome.value.name);
      setDescription(outcome.value.description);
      setStale(false);
      setNotice('Profile saved.');
      return;
    }
    setStale(outcome.kind === 'STALE');
    setMessage(failureText(outcome));
  }
  async function reload() {
    setBusy(true);
    setMessage('');
    try {
      const response = await api.readProfile(saved.id);
      const body = (await response.json()) as { guild?: unknown };
      const guild = ManagedGuildSchema.safeParse(body?.guild);
      if (!response.ok || !guild.success || guild.data.id.toLowerCase() !== saved.id.toLowerCase())
        throw Error('read failed');
      setSaved(guild.data);
      setStale(false);
      setNotice('Saved details reloaded. Your edits are kept; review them, then save.');
    } catch {
      setMessage('Saved details could not be loaded. Your edits are kept on this page.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="orientation-card" aria-labelledby="guild-profile-heading">
      <h2 id="guild-profile-heading">Profile</h2>
      <p>
        Public address: <code>/guilds/{saved.slug}</code>. Saved revision {saved.revision}.
      </p>
      {!writesAvailable && (
        <p role="status">
          Editing the profile is currently unavailable. Saved details remain readable.
        </p>
      )}
      <form onSubmit={submit} noValidate aria-busy={busy}>
        <fieldset className="orientation-fields" disabled={busy || !writesAvailable}>
          <legend className="visually-hidden">Guild profile fields</legend>
          <label>
            Guild name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(e) => edit('name', e.target.value)}
            />
          </label>
          <label>
            Description
            <textarea
              maxLength={4000}
              rows={6}
              value={description}
              onChange={(e) => edit('description', e.target.value)}
            />
          </label>
        </fieldset>
        {message && (
          <p role="alert" tabIndex={-1} ref={alert}>
            {message}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="orientation-actions">
          <button
            className="button"
            type="submit"
            disabled={busy || !writesAvailable || stale || !changed}
          >
            {busy ? 'Saving…' : 'Save profile'}
          </button>
          {stale && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => void reload()}
            >
              Reload saved details
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

const STATE_LABEL = { DRAFT: 'Draft', PUBLISHED: 'Published', WITHDRAWN: 'Withdrawn' } as const;
export function GuildUpdatesManager({
  guildId,
  updates: initial,
  founder,
  writesAvailable,
  api = fetchGuildManageApi,
}: {
  guildId: string;
  updates: ManagedGuildUpdate[];
  founder: boolean;
  writesAvailable: boolean;
  api?: GuildManageApi;
}) {
  const [updates, setUpdates] = useState(initial);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState('');
  const [busy, setBusy] = useState<string | null>(null),
    [message, setMessage] = useState(''),
    [notice, setNotice] = useState('');
  const drafts = useRef(createManageRunner());
  const steps = useRef(createManageRunner());
  const alert = useAlert(message);
  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const checked = DraftGuildUpdateInputSchema.safeParse({ guildId, title, body });
    if (!checked.success) {
      setMessage('Enter a title (up to 200 characters) and update text (up to 4000 characters).');
      return;
    }
    setBusy('draft');
    setMessage('');
    setNotice('');
    const outcome = await drafts.current.run(
      checked.data,
      (key) => api.draftUpdate(checked.data, key),
      (raw) => parseUpdateResult(raw, { kind: 'DRAFT', ...checked.data }),
    );
    setBusy(null);
    if (outcome.kind === 'BUSY') return;
    if (outcome.kind !== 'DONE') {
      setMessage(failureText(outcome));
      return;
    }
    const created = outcome.value;
    setUpdates((list) => [created, ...list.filter((u) => u.id !== created.id)]);
    setTitle('');
    setBody('');
    setNotice('Draft saved. It is private until the Founder publishes it.');
  }
  async function step(update: ManagedGuildUpdate, action: 'PUBLISH' | 'WITHDRAW') {
    const input = { guildId, action };
    setBusy(update.id + action);
    setMessage('');
    setNotice('');
    const outcome = await steps.current.run(
      { updateId: update.id, ...input },
      (key) => api.stepUpdate(update.id, input, key),
      (raw) => parseUpdateResult(raw, { kind: action, guildId, updateId: update.id }),
    );
    setBusy(null);
    if (outcome.kind === 'BUSY') return;
    if (outcome.kind !== 'DONE') {
      setMessage(failureText(outcome));
      return;
    }
    const result = outcome.value;
    // A withdrawn update leaves the managed list, exactly as the server's own list omits it.
    setUpdates((list) =>
      result.state === 'WITHDRAWN'
        ? list.filter((u) => u.id !== result.id)
        : list.map((u) => (u.id === result.id ? result : u)),
    );
    setNotice(
      action === 'PUBLISH'
        ? result.state === 'PUBLISHED'
          ? 'Update published.'
          : 'This update was already withdrawn.'
        : 'Update withdrawn.',
    );
  }
  return (
    <section className="orientation-card" aria-labelledby="guild-updates-heading">
      <h2 id="guild-updates-heading">Public updates</h2>
      <p>Drafts are private. A published update appears on the public Guild page.</p>
      {!writesAvailable && (
        <p role="status">
          New drafts and publishing are currently unavailable. Withdrawing stays available.
        </p>
      )}
      {!founder && (
        <p>Only the Founder can publish an update. You can draft and withdraw your own drafts.</p>
      )}
      <form onSubmit={createDraft} noValidate aria-busy={busy === 'draft'}>
        <fieldset className="orientation-fields" disabled={busy === 'draft' || !writesAvailable}>
          <legend className="visually-hidden">New update draft</legend>
          <label>
            Title
            <input
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Update text
            <textarea
              required
              maxLength={4000}
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
        </fieldset>
        <div className="orientation-actions">
          <button className="button" type="submit" disabled={busy !== null || !writesAvailable}>
            {busy === 'draft' ? 'Saving…' : 'Save draft'}
          </button>
        </div>
      </form>
      {message && (
        <p role="alert" tabIndex={-1} ref={alert}>
          {message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {updates.length === 0 ? (
        <p>No updates yet.</p>
      ) : (
        <ul className="guild-update-list">
          {updates.map((update) => (
            <li className="guild-update" key={update.id}>
              <h3>{update.title}</h3>
              <p className="orientation-hint">
                <span className="guild-update-state">{STATE_LABEL[update.state]}</span>
              </p>
              <p>{update.body}</p>
              <div className="orientation-actions">
                {founder && update.state === 'DRAFT' && (
                  <button
                    className="button small"
                    type="button"
                    aria-label={'Publish update: ' + update.title}
                    disabled={busy !== null || !writesAvailable}
                    onClick={() => void step(update, 'PUBLISH')}
                  >
                    {busy === update.id + 'PUBLISH' ? 'Publishing…' : 'Publish'}
                  </button>
                )}
                {(founder || update.state === 'DRAFT') && (
                  <button
                    className="button small secondary"
                    type="button"
                    aria-label={'Withdraw update: ' + update.title}
                    disabled={busy !== null}
                    onClick={() => void step(update, 'WITHDRAW')}
                  >
                    {busy === update.id + 'WITHDRAW' ? 'Withdrawing…' : 'Withdraw'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
