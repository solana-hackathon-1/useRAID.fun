import type { PracticeReviewReadRecord } from '../skills/practice-review-read-storage';
const wrap = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } as const;
function when(value: string) {
  return (
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' UTC'
  );
}
/** Portable stateless evidence view. The server host must authorize and validate before rendering. */
export function PracticeReviewCase({
  review: r,
  actionsAvailable = false,
}: {
  review: PracticeReviewReadRecord;
  actionsAvailable?: boolean;
}) {
  const { assignment: a, definition: d, submission: s } = r;
  return (
    <div style={wrap}>
      <section className="orientation-card" aria-label="Review scope">
        <h2>{a.purpose === 'OWNERSHIP_REVIEW' ? 'Ownership review' : 'Assessment review'}</h2>
        <p>
          Private evidence for this assigned case. Access was checked for this page and may change.
          Recheck before relying on it.
        </p>
        <p>
          Assignment expires: <time dateTime={a.expiresAt}>{when(a.expiresAt)}</time>.
        </p>
        {!actionsAvailable && (
          <p>Evidence view only. This screen does not record review decisions.</p>
        )}
      </section>
      <section className="orientation-card" aria-labelledby="original-submission">
        <h2 id="original-submission">Original submission</h2>
        <p>
          Submitted: <time dateTime={s.submittedAt}>{when(s.submittedAt)}</time>.
        </p>
        <p>
          Original ownership declaration: Unconfirmed. This original submission does not include
          later ownership findings or assessment results.
        </p>
        <h3>Answer</h3>
        <pre style={wrap}>{s.answer}</pre>
        <h3>Explanation</h3>
        <p>{s.explanation}</p>
        <h3>Declared tools and assistance</h3>
        <p>
          {s.toolsUsed.length ? 'Tools declared: ' + s.toolsUsed.join(', ') : 'No tools declared'}.
        </p>
        <p>AI assistance declared: {s.aiAssistanceUsed ? 'Yes' : 'No'}.</p>
        <p>{s.assistanceDisclosure}</p>
        <p>Declarations alone do not establish ownership, compliance or assessed skill.</p>
      </section>
      <section className="orientation-card" aria-labelledby="original-criteria">
        <h2 id="original-criteria">Original review criteria</h2>
        <p>
          {d.title} — {d.skillId} ({d.skillDomain}), practice level {d.targetRank}.
        </p>
        <ul>
          {d.rubric.criteria.map((c) => (
            <li key={c.id}>
              <strong>{c.required ? 'Required' : 'Optional'}:</strong> {c.description}
            </li>
          ))}
        </ul>
        <p>{d.passConditions}</p>
        <p>
          Evaluation:{' '}
          {d.evaluatorMethod === 'MANUAL' ? 'Manual review' : 'Automated checks with manual review'}
          .
        </p>
        <p>
          Rubric: {d.rubric.reference.recordId}, version {d.rubric.reference.revision}.
        </p>
      </section>
      <details className="orientation-card">
        <summary>Original task and agreed conditions</summary>
        <h2>Original task</h2>
        <p>{d.brief}</p>
        <p>Expected time: about {d.expectedMinutes} minutes (an expectation, not a deadline).</p>
        <p>
          Variant: {d.variantId}. Definition: {d.reference.recordId}, version {d.reference.revision}
          .
        </p>
        <h3>Materials</h3>
        {d.inputs.map((input, i) => (
          <section key={i}>
            <h4>
              {input.label} ({input.material === 'PUBLIC' ? 'Public' : 'Synthetic'})
            </h4>
            <pre style={wrap}>{input.content}</pre>
          </section>
        ))}
        <h3>Permitted tools and AI assistance</h3>
        <p>
          {d.tools.permitted.length
            ? 'Permitted tools: ' + d.tools.permitted.join(', ')
            : 'No specific tools listed'}
          .
        </p>
        <p>AI assistance is {d.tools.aiAssistance === 'ALLOWED' ? 'allowed' : 'prohibited'}.</p>
        <p>{d.tools.disclosure}</p>
        <p>
          Maximum attempts: {d.maximumAttempts}. Cooldown: {d.cooldownSeconds} seconds.
        </p>
        <h3>Accommodations policy</h3>
        <p>{d.accommodationPolicy}</p>
      </details>
    </div>
  );
}
