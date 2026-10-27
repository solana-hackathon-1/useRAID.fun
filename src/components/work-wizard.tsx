'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildTerms,
  defaultWizardForm,
  formFromTerms,
  type FieldProblem,
  type WizardForm,
} from '../work-loop/creation-form';
import {
  readWizardRecovery,
  writeWizardRecovery,
  clearWizardRecovery,
  saveWizardIntent,
  type WizardRecovery,
} from '../work-loop/creation-recovery';
import type { Recommendation } from '../work-loop/recommendation-contracts';
import { assetKey, formatDisplayAmount } from '../contracts/assets';
import { createCreationClient, type CreationState } from '../work-http/creation-client';
import {
  describeWorkFailure,
  newRequestKey,
  type FailureKind,
} from '../work-http/workspace-client';

type Client = ReturnType<typeof createCreationClient>;
const defaultClient = createCreationClient();
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

const STEPS = [
  'Outcome',
  'Acceptance',
  'Recommendation',
  'Format',
  'Reward and terms',
  'Review and publish',
] as const;
const STEP_OF: Record<string, number> = {
  title: 0,
  publicSummary: 0,
  category: 0,
  outcome: 0,
  deliverables: 1,
  acceptanceCriteria: 1,
  exclusions: 1,
  dependencies: 1,
  difficulty: 3,
  skills: 3,
  admission: 3,
  visibility: 3,
};
const FIELD_TEXT: Record<string, string> = {
  title: 'Title',
  publicSummary: 'Public summary',
  category: 'Category',
  outcome: 'Outcome',
  deliverables: 'Deliverables',
  acceptanceCriteria: 'Acceptance criteria',
  skills: 'Required skills',
  rewards: 'Reward',
  reviewerAccountId: 'Reviewer account',
  days: 'Deadlines',
  reviewEvidence: 'Review evidence',
};
const PROBLEM_TEXT: Record<string, string> = {
  DEADLINE_PASSED: 'The commitment deadline has passed. Save again with later deadlines.',
  APPROVAL_REQUIRED: 'Higher difficulty needs application approval.',
  UNSUPPORTED_MODE: 'This format is not supported yet. Use public, solo and human participants.',
  INVALID_TERMS: 'The saved terms are not valid.',
  TERMS_VERSION_CHANGED: 'A newer version was saved. Reload to review the current draft.',
  FUNDING_NOT_COVERED:
    'The simulated reserve does not cover every reward asset, so this reward cannot be published.',
};
const VISIBILITY_TEXT: Record<WizardForm['visibility'], string> = {
  PUBLIC: 'Public',
  TRUSTED_LISTING: 'Trusted listing (not supported yet)',
  CONFIDENTIAL_LISTING: 'Confidential listing (not supported yet)',
  INVITE_ONLY: 'Invite only (not supported yet)',
};
const RANKS = ['E', 'D', 'C', 'B', 'A', 'S'] as const;
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
interface Notice {
  intent: string;
  kind: FailureKind;
  text: string;
}
/** One idempotency key per unchanged intent, kept across unconfirmed failures so a retry cannot duplicate. */
function useRunner() {
  const keys = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  async function run<T>(
    intent: string,
    fingerprint: unknown,
    exec: (key: string) => Promise<T>,
    done: (result: T) => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = intent + ':' + JSON.stringify(fingerprint);
    let key = keys.current.get(id);
    if (!key) keys.current.set(id, (key = newRequestKey()));
    setBusy(intent);
    setNotice(null);
    try {
      const result = await exec(key);
      keys.current.delete(id);
      done(result);
    } catch (error) {
      const described = describeWorkFailure(error);
      if (described.kind !== 'RETRY_SAME_REQUEST') keys.current.delete(id);
      setNotice({ intent, kind: described.kind, text: described.message });
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return { run, busy, notice };
}
function restore(state: CreationState): { form: WizardForm; saved: boolean } {
  const latest = state.drafts.find((d) => d.state === 'DRAFT');
  return latest
    ? { form: formFromTerms(latest.terms, new Date()), saved: true }
    : { form: defaultWizardForm(), saved: false };
}
type WizardProps = { accountId: string; initialState: CreationState; client?: Client };
/** Account changes remount all in-memory intent, notices, terms and form state. */
export function WorkWizard(props: WizardProps) {
  return <AccountWorkWizard key={props.accountId} {...props} />;
}
function AccountWorkWizard({ accountId, initialState, client = defaultClient }: WizardProps) {
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const runner = useRunner();
  const [start] = useState(() => restore(initialState));
  const [state, setState] = useState(initialState);
  const [form, setFormState] = useState<WizardForm>(start.form);
  const [step, setStep] = useState(0);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const draft = state.drafts.find((d) => d.state === 'DRAFT') ?? null;
  const recovery = useRef<WizardRecovery>({
    version: 'v1',
    accountId,
    form: start.form,
    binding: draft
      ? {
          listingId: draft.listingId,
          termsVersionId: draft.termsVersionId,
          revision: draft.revision,
        }
      : null,
    pending: null,
  });
  useEffect(() => {
    try {
      const restored = readWizardRecovery(window.sessionStorage, accountId);
      if (restored) {
        recovery.current = restored;
        setFormState(restored.form);
        // Stored form text is never evidence that a server version was saved.
        setSavedFingerprint(null);
      }
    } catch {}
  }, [accountId]);
  const [savedFingerprint, setSavedFingerprint] = useState<string | null>(
    start.saved ? JSON.stringify(start.form) : null,
  );
  // Terms are assembled once per unchanged form so a retried save carries the same bytes and key.
  const built = useRef<{ fingerprint: string; value: ReturnType<typeof buildTerms> } | null>(null);
  const fingerprint = JSON.stringify(form);
  const unsaved = savedFingerprint !== fingerprint;
  const catalog = state.assets;
  const busy = runner.busy !== null;
  function setForm(next: WizardForm) {
    setFormState(next);
    try {
      recovery.current = { ...recovery.current, form: next };
      writeWizardRecovery(window.sessionStorage, recovery.current);
    } catch {}
  }
  const patch = (changes: Partial<WizardForm>) => setForm({ ...form, ...changes });
  function termsFor() {
    if (!built.current || built.current.fingerprint !== fingerprint)
      built.current = { fingerprint, value: buildTerms(form, catalog, new Date()) };
    return built.current.value;
  }
  function save() {
    const result = termsFor();
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    const input = {
      listingId: draft?.listingId ?? null,
      expectedRevision: draft?.revision ?? 0,
      terms: result.terms,
    };
    void runner.run(
      'save',
      input,
      (key) =>
        saveWizardIntent({
          recovery: recovery.current,
          input,
          fingerprint,
          key,
          save: client.saveDraft,
          persist: (value) => {
            writeWizardRecovery(window.sessionStorage, value);
            recovery.current = value;
          },
        }),
      (saved) => {
        setState({
          ...state,
          drafts: [
            saved.draft,
            ...state.drafts.filter((d) => d.listingId !== saved.draft.listingId),
          ],
        });
        setSavedFingerprint(fingerprint);
      },
    );
  }
  function publish() {
    if (!draft) return;
    void runner.run(
      'publish',
      draft.termsVersionId,
      (key) => client.publishDraft(draft.listingId, draft.termsVersionId, key),
      (result) => {
        setPublished(result.slotId);
        try {
          clearWizardRecovery(window.sessionStorage, accountId);
        } catch {}
        recovery.current = { ...recovery.current, binding: null, pending: null };
        setState({
          ...state,
          drafts: state.drafts.map((d) =>
            d.listingId === draft.listingId
              ? { ...d, state: 'OPEN', reserved: true, ready: false }
              : d,
          ),
        });
      },
    );
  }
  const notice = (intent: string) =>
    runner.notice?.intent === intent ? (
      <p role="alert">
        {runner.notice.text}
        {runner.notice.kind === 'RETRY_SAME_REQUEST' && ' Press the same button again to retry.'}
        {runner.notice.kind === 'SIGN_IN' && <a href="/creator/account"> Sign in</a>}
      </p>
    ) : null;

  return (
    <div className="orientation-card" style={wrap}>
      <h2 id="wizard-title">Create a Raid</h2>
      <p className="orientation-hint">
        Everything here uses simulated funds. Your draft is kept if you leave or something fails.
      </p>
      {!state.savesAvailable && (
        <p role="status">Saving drafts is currently unavailable; you can still fill in the form.</p>
      )}
      <nav aria-label="Steps">
        <ol
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            padding: 0,
            listStyle: 'none',
          }}
        >
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                className={i === step ? 'button' : 'button secondary'}
                aria-current={i === step ? 'step' : undefined}
                disabled={!ready}
                onClick={() => setStep(i)}
              >
                {i + 1}. {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <form onSubmit={(e) => e.preventDefault()} noValidate aria-labelledby="wizard-title">
        <fieldset className="orientation-fields" disabled={!ready || busy}>
          <legend>
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </legend>
          {step === 0 && (
            <>
              <Text
                label="Title"
                value={form.title}
                max={200}
                onChange={(v) => patch({ title: v })}
              />
              <Text
                label="Safe public summary"
                hint="Shown to everyone. Do not include private details."
                value={form.publicSummary}
                max={1000}
                onChange={(v) => patch({ publicSummary: v })}
              />
              <Text
                label="Category"
                value={form.category}
                max={100}
                onChange={(v) => patch({ category: v })}
              />
              <Area
                label="What needs to exist or change?"
                value={form.outcome}
                onChange={(v) => patch({ outcome: v })}
              />
            </>
          )}
          {step === 1 && (
            <>
              <Area
                label="Deliverables (one per line)"
                value={form.deliverables}
                onChange={(v) => patch({ deliverables: v })}
              />
              <Area
                label="Acceptance criteria (one per line, each measurable)"
                hint="Describe evidence that proves success. “Make it perfect” cannot be checked."
                value={form.acceptanceCriteria}
                onChange={(v) => patch({ acceptanceCriteria: v })}
              />
              <Area
                label="Exclusions (one per line)"
                value={form.exclusions}
                onChange={(v) => patch({ exclusions: v })}
              />
              <Area
                label="Dependencies (one per line)"
                value={form.dependencies}
                onChange={(v) => patch({ dependencies: v })}
              />
            </>
          )}
          {step === 2 && (
            <RecommendationStep
              form={form}
              enabled={state.recommendationsAvailable}
              recommendation={recommendation}
              busy={busy}
              onEstimate={(input) =>
                void runner.run(
                  'recommend',
                  input,
                  () => client.recommend(input),
                  (result) => setRecommendation(result),
                )
              }
              onApply={(rec) =>
                patch({
                  difficulty: rec.difficulty,
                  skills: rec.requiredSkills.map((s) => ({
                    skillId: s.skillId,
                    minimumRank: s.minimumRank,
                    assessmentPolicyVersion:
                      form.skills[0]?.assessmentPolicyVersion ?? 'starter-v1',
                  })),
                  admission: ['B', 'A', 'S'].includes(rec.difficulty)
                    ? 'APPLICATION'
                    : form.admission,
                })
              }
              notice={notice('recommend')}
              catalog={catalog}
            />
          )}
          {step === 3 && (
            <>
              <label>
                Difficulty
                <select
                  value={form.difficulty}
                  onChange={(e) =>
                    patch({ difficulty: e.target.value as WizardForm['difficulty'] })
                  }
                >
                  {RANKS.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
              {form.skills.map((skill, i) => (
                <div key={i} role="group" aria-label={'Skill ' + (i + 1)}>
                  <Text
                    label={'Skill ' + (i + 1) + ' id'}
                    value={skill.skillId}
                    max={100}
                    onChange={(v) =>
                      patch({
                        skills: form.skills.map((x, j) => (j === i ? { ...x, skillId: v } : x)),
                      })
                    }
                  />
                  <label>
                    Skill {i + 1} minimum rank
                    <select
                      value={skill.minimumRank}
                      onChange={(e) =>
                        patch({
                          skills: form.skills.map((x, j) =>
                            j === i
                              ? { ...x, minimumRank: e.target.value as typeof skill.minimumRank }
                              : x,
                          ),
                        })
                      }
                    >
                      {RANKS.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </label>
                  {form.skills.length > 1 && (
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => patch({ skills: form.skills.filter((_, j) => j !== i) })}
                    >
                      Remove skill {i + 1}
                    </button>
                  )}
                </div>
              ))}
              {form.skills.length < 10 && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    patch({
                      skills: [
                        ...form.skills,
                        { skillId: '', minimumRank: 'E', assessmentPolicyVersion: 'starter-v1' },
                      ],
                    })
                  }
                >
                  Add a skill
                </button>
              )}
              <label>
                Who can take it
                <select
                  value={form.admission}
                  onChange={(e) => patch({ admission: e.target.value as WizardForm['admission'] })}
                >
                  <option value="INSTANT">Instant acceptance</option>
                  <option value="APPLICATION">Application and offer</option>
                </select>
                <span className="orientation-hint">
                  Difficulty B and above needs application approval.
                </span>
              </label>
              <label>
                Visibility
                <select
                  value={form.visibility}
                  onChange={(e) =>
                    patch({ visibility: e.target.value as WizardForm['visibility'] })
                  }
                >
                  {(Object.keys(VISIBILITY_TEXT) as WizardForm['visibility'][]).map((v) => (
                    <option key={v} value={v}>
                      {VISIBILITY_TEXT[v]}
                    </option>
                  ))}
                </select>
                <span className="orientation-hint">
                  Only a safe teaser (title and public summary) is ever shown to visitors.
                </span>
              </label>
              <p className="orientation-hint">Format: solo, human participants.</p>
            </>
          )}
          {step === 4 && <RewardStep form={form} patch={patch} catalog={catalog} />}
          {step === 5 && (
            <ReviewStep
              draft={draft}
              unsaved={unsaved}
              state={state}
              published={published}
              problems={problems}
              onGoto={setStep}
              onSave={save}
              onPublish={publish}
              busy={busy}
              notice={
                <>
                  {notice('save')}
                  {notice('publish')}
                </>
              }
            />
          )}
        </fieldset>
        <p className="orientation-actions">
          {step > 0 && (
            <button
              type="button"
              className="button secondary"
              disabled={!ready || busy}
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
          )}{' '}
          {step < STEPS.length - 1 && (
            <button
              type="button"
              className="button"
              disabled={!ready || busy}
              onClick={() => setStep(step + 1)}
            >
              Continue
            </button>
          )}
        </p>
      </form>
    </div>
  );
}
function Text({
  label,
  value,
  onChange,
  max,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  hint?: string;
}) {
  return (
    <label>
      {label}
      <input value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="orientation-hint">{hint}</span>}
    </label>
  );
}
function Area({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <label>
      {label}
      <textarea
        rows={4}
        maxLength={8000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="orientation-hint">{hint}</span>}
    </label>
  );
}
function RecommendationStep({
  form,
  enabled,
  recommendation,
  busy,
  onEstimate,
  onApply,
  notice,
  catalog,
}: {
  catalog: CreationState['assets'];
  form: WizardForm;
  enabled: boolean;
  recommendation: Recommendation | null;
  busy: boolean;
  onEstimate: (input: Parameters<Client['recommend']>[0]) => void;
  onApply: (rec: Recommendation) => void;
  notice: React.ReactNode;
}) {
  const [signals, setSignals] = useState({
    integrations: 0,
    dependencies: 0,
    uncertainty: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH',
    consequenceOfError: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH',
    verificationCost: 'LOW' as 'LOW' | 'MEDIUM' | 'HIGH',
    deadlinePressure: 'NORMAL' as 'NONE' | 'NORMAL' | 'TIGHT',
  });
  const [rewardAssetKey, setRewardAssetKey] = useState('');
  if (!enabled)
    return (
      <p role="status">
        Recommendations are not configured here, so there is no estimate. Choose difficulty, skills
        and reward yourself in the next steps.
      </p>
    );
  const skill = form.skills.find((s) => s.skillId.trim());
  const criteria = form.acceptanceCriteria.split('\n').filter((l) => l.trim());
  const level = (key: 'uncertainty' | 'consequenceOfError' | 'verificationCost', label: string) => (
    <label key={key}>
      {label}
      <select
        value={signals[key]}
        onChange={(e) => setSignals({ ...signals, [key]: e.target.value as 'LOW' })}
      >
        <option value="LOW">Low</option>
        <option value="MEDIUM">Medium</option>
        <option value="HIGH">High</option>
      </select>
    </label>
  );
  return (
    <>
      <p className="orientation-hint">
        An optional estimate from the signals below. It is advice, not a price or a promise, and you
        keep every choice.
      </p>
      <label>
        Integrations
        <input
          type="number"
          min={0}
          max={50}
          value={signals.integrations}
          onChange={(e) => setSignals({ ...signals, integrations: Number(e.target.value) })}
        />
      </label>
      <label>
        Dependencies
        <input
          type="number"
          min={0}
          max={50}
          value={signals.dependencies}
          onChange={(e) => setSignals({ ...signals, dependencies: Number(e.target.value) })}
        />
      </label>
      {level('uncertainty', 'Uncertainty')}
      {level('consequenceOfError', 'Consequence of error')}
      {level('verificationCost', 'Verification cost')}
      <label>
        Deadline pressure
        <select
          value={signals.deadlinePressure}
          onChange={(e) => setSignals({ ...signals, deadlinePressure: e.target.value as 'NONE' })}
        >
          <option value="NONE">None</option>
          <option value="NORMAL">Normal</option>
          <option value="TIGHT">Tight</option>
        </select>
      </label>
      <label>
        Reward asset (optional, for a range in token units)
        <select value={rewardAssetKey} onChange={(e) => setRewardAssetKey(e.target.value)}>
          <option value="">No asset</option>
          {catalog.map((a) => (
            <option key={assetKey(a.policy.assetId)} value={assetKey(a.policy.assetId)}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="button"
        disabled={busy || !skill || !criteria.length || !form.outcome.trim()}
        onClick={() =>
          onEstimate({
            ...signals,
            ...(rewardAssetKey
              ? {
                  rewardAsset: catalog.find((a) => assetKey(a.policy.assetId) === rewardAssetKey)!
                    .policy,
                }
              : {}),
            outcome: form.outcome.trim(),
            acceptanceCriteria: criteria.map((c) => c.trim()),
            skillDomains: [{ skillId: skill!.skillId.trim(), role: 'PRIMARY' }],
          })
        }
      >
        Get estimate
      </button>
      {!skill && <p className="orientation-hint">Add a skill id in the Format step first.</p>}
      {notice}
      {recommendation && (
        <section aria-label="Estimate">
          <h3>Estimate (advice only)</h3>
          <p>
            Suggested difficulty {recommendation.difficulty}; confidence{' '}
            {recommendation.confidence.toLowerCase()}. Rubric {recommendation.policyVersion} (
            {recommendation.rubricEvaluation === 'REVIEWED' ? 'reviewed' : 'unevaluated example'}).
          </p>
          <p>
            Estimated {recommendation.estimatedDurationDays.low}–
            {recommendation.estimatedDurationDays.high} days.{' '}
            {recommendation.rewardSuggestion.status === 'RANGE'
              ? `Reward range ${formatDisplayAmount(recommendation.rewardSuggestion.low, recommendation.rewardSuggestion.policy.verifiedDecimals)}–${formatDisplayAmount(recommendation.rewardSuggestion.high, recommendation.rewardSuggestion.policy.verifiedDecimals)} in token units; no price is implied.`
              : recommendation.rewardSuggestion.reason === 'NO_ASSET_SELECTED'
                ? 'Choose a reward asset above to see a range.'
                : 'No reviewed price basis exists for this asset, so no range is shown.'}
          </p>
          {recommendation.missingInformation.length > 0 && (
            <>
              <p>Missing information:</p>
              <ul>
                {recommendation.missingInformation.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            className="button secondary"
            onClick={() => onApply(recommendation)}
          >
            Use suggested difficulty and skills
          </button>
        </section>
      )}
    </>
  );
}
function RewardStep({
  form,
  patch,
  catalog,
}: {
  form: WizardForm;
  patch: (changes: Partial<WizardForm>) => void;
  catalog: CreationState['assets'];
}) {
  const setDays = (key: keyof WizardForm['days'], value: number) =>
    patch({ days: { ...form.days, [key]: value } });
  return (
    <>
      <h3>Reward</h3>
      {!catalog.length && (
        <p role="status">No reward assets are configured, so a reward cannot be set.</p>
      )}
      {form.rewards.map((leg, i) => (
        <div key={i} role="group" aria-label={'Reward ' + (i + 1)}>
          <label>
            Reward {i + 1} asset
            <select
              value={leg.assetKey}
              onChange={(e) =>
                patch({
                  rewards: form.rewards.map((x, j) =>
                    j === i ? { ...x, assetKey: e.target.value } : x,
                  ),
                })
              }
            >
              <option value="">Choose an asset</option>
              {catalog.map((a) => (
                <option key={assetKey(a.policy.assetId)} value={assetKey(a.policy.assetId)}>
                  {a.label}
                  {a.funded ? '' : ' (not covered by the simulated reserve)'}
                </option>
              ))}
            </select>
          </label>
          <Text
            label={'Reward ' + (i + 1) + ' amount'}
            value={leg.amount}
            max={40}
            onChange={(v) =>
              patch({ rewards: form.rewards.map((x, j) => (j === i ? { ...x, amount: v } : x)) })
            }
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => patch({ rewards: form.rewards.filter((_, j) => j !== i) })}
          >
            Remove reward {i + 1}
          </button>
        </div>
      ))}
      {form.rewards.length < 10 && catalog.length > 0 && (
        <button
          type="button"
          className="button secondary"
          onClick={() => patch({ rewards: [...form.rewards, { assetKey: '', amount: '' }] })}
        >
          Add a reward asset
        </button>
      )}
      <h3>Review</h3>
      <Text
        label="Independent reviewer account"
        hint="Must not be the person who takes the work."
        value={form.reviewerAccountId}
        max={200}
        onChange={(v) => patch({ reviewerAccountId: v })}
      />
      <Area
        label="Evidence the reviewer needs"
        value={form.reviewEvidence}
        onChange={(v) => patch({ reviewEvidence: v })}
      />
      <label>
        Maximum revision rounds
        <input
          type="number"
          min={0}
          max={10}
          value={form.maxRevisionRounds}
          onChange={(e) => patch({ maxRevisionRounds: Number(e.target.value) })}
        />
      </label>
      <h3>Deadlines (whole days from now, increasing)</h3>
      {(
        [
          ['commitment', 'Commitment'],
          ['preparation', 'Preparation'],
          ['submission', 'Submission'],
          ['review', 'Review'],
          ['operationalClosure', 'Operational closure'],
        ] as const
      ).map(([key, label]) => (
        <label key={key}>
          {label} deadline (days)
          <input
            type="number"
            min={1}
            max={3650}
            value={form.days[key]}
            onChange={(e) => setDays(key, Number(e.target.value))}
          />
        </label>
      ))}
      <details>
        <summary>Rights, withdrawal and dispute policies</summary>
        <Area
          label="Rights"
          value={form.rightsPolicy}
          onChange={(v) => patch({ rightsPolicy: v })}
        />
        <Area
          label="Portfolio"
          value={form.portfolioPolicy}
          onChange={(v) => patch({ portfolioPolicy: v })}
        />
        <Area
          label="Withdrawal"
          value={form.withdrawalPolicy}
          onChange={(v) => patch({ withdrawalPolicy: v })}
        />
        <Area
          label="Termination"
          value={form.terminationPolicy}
          onChange={(v) => patch({ terminationPolicy: v })}
        />
        <Area
          label="Dispute"
          value={form.disputePolicy}
          onChange={(v) => patch({ disputePolicy: v })}
        />
        <Area
          label="Finality"
          value={form.finalityPolicy}
          onChange={(v) => patch({ finalityPolicy: v })}
        />
        <Area
          label="Allowed tools and AI"
          value={form.allowedToolsPolicy}
          onChange={(v) => patch({ allowedToolsPolicy: v })}
        />
      </details>
    </>
  );
}
function ReviewStep({
  draft,
  unsaved,
  state,
  published,
  problems,
  onGoto,
  onSave,
  onPublish,
  busy,
  notice,
}: {
  draft: CreationState['drafts'][number] | null;
  unsaved: boolean;
  state: CreationState;
  published: string | null;
  problems: FieldProblem[];
  onGoto: (step: number) => void;
  onSave: () => void;
  onPublish: () => void;
  busy: boolean;
  notice: React.ReactNode;
}) {
  const shown = draft && !unsaved ? draft : null;
  return (
    <>
      <p className="orientation-hint">
        Saving checks every field on the server. Nothing is published until you press Publish.
      </p>
      <button
        type="button"
        className="button"
        disabled={busy || !state.savesAvailable}
        onClick={onSave}
      >
        {draft ? 'Save changes' : 'Save draft'}
      </button>
      {unsaved && draft && <p role="status">You have changes that are not saved yet.</p>}
      {problems.length > 0 && (
        <div role="alert">
          <p>Fix these before saving:</p>
          <ul>
            {problems.map((p) => (
              <li key={p.field + p.message}>
                {FIELD_TEXT[p.field] ?? p.field}: {p.message}{' '}
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onGoto(STEP_OF[p.field] ?? 4)}
                >
                  Go to step {(STEP_OF[p.field] ?? 4) + 1}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice}
      {published && (
        <p role="status">Published. The reward is reserved (simulated) for this Raid.</p>
      )}
      {shown && (
        <section aria-label="Reward review">
          <h3>Reward review</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Amount</th>
                <th scope="col">Reserve</th>
              </tr>
            </thead>
            <tbody>
              {shown.review.legs.map((leg, i) => (
                <tr key={i}>
                  <td>{leg.label}</td>
                  <td>{leg.display}</td>
                  <td>{leg.funded ? 'Covered (simulated)' : 'Not covered'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Fees: {shown.review.fee.amount} paid by the {shown.review.fee.payer.toLowerCase()}.{' '}
            {shown.review.rent.note} All funds are simulated.
          </p>
          <p>
            {shown.review.coverage === 'ALL_FUNDED'
              ? 'Every reward asset is covered.'
              : 'Not every reward asset is covered, so this cannot be published.'}
          </p>
          {shown.problems.length > 0 && (
            <ul aria-label="Publication problems">
              {shown.problems.map((p) => (
                <li key={p}>{PROBLEM_TEXT[p] ?? p}</li>
              ))}
            </ul>
          )}
          {!published && (
            <button
              type="button"
              className="button"
              disabled={busy || !shown.ready || !state.publishAvailable}
              onClick={onPublish}
            >
              Publish
            </button>
          )}
          {!state.publishAvailable && <p role="status">Publishing is currently unavailable.</p>}
        </section>
      )}
    </>
  );
}
