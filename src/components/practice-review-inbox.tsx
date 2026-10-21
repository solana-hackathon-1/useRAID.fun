import type { PracticeReviewInboxState } from '../skills/practice-review-inbox-page';
function utc(value: string) {
  return new Date(value)
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', ' UTC')
    .replace('Z', ' UTC');
}
/** Render only canonical authorized metadata; this view never authorizes opening or saving a case. */
export function PracticeReviewInbox({ state }: { state: PracticeReviewInboxState }) {
  return (
    <div className="studio stack" style={{ maxWidth: 900, paddingBlock: 32 }}>
      <header className="stack">
        <p className="muted">Evaluator</p>
        <h1>Your practice reviews</h1>
        <p>
          Current assignments for your account. Access is checked again when you open a case or save
          a finding.
        </p>
      </header>
      {state.status === 'READY' ? (
        <>
          <p>
            Observed <time dateTime={state.page.observedAt}>{utc(state.page.observedAt)}</time>.
            Refresh to check for new or expired assignments.
          </p>
          {state.page.entries.length === 0 ? (
            <p role="status">
              No current assignments on this page. Refresh from the beginning to check again.
            </p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {state.page.entries.map((entry) => {
                const path =
                  '/evaluator/practice/' +
                  encodeURIComponent(entry.assignmentId) +
                  '/submissions/' +
                  encodeURIComponent(entry.submissionId);
                return (
                  <li
                    className="panel stack"
                    key={entry.assignmentId}
                    style={{ padding: 24, minWidth: 0, overflowWrap: 'anywhere' }}
                  >
                    <h2>
                      {entry.purpose === 'OWNERSHIP_REVIEW'
                        ? 'Ownership review'
                        : 'Skill assessment'}
                    </h2>
                    <p>
                      Assignment <code>{entry.assignmentId}</code>
                    </p>
                    <p>
                      Expires <time dateTime={entry.expiresAt}>{utc(entry.expiresAt)}</time>
                    </p>
                    <nav
                      aria-label={'Actions for assignment ' + entry.assignmentId}
                      style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}
                    >
                      <a className="button secondary" href={path + '?purpose=' + entry.purpose}>
                        Read original case
                      </a>
                      <a
                        className="button"
                        href={
                          path +
                          (entry.purpose === 'OWNERSHIP_REVIEW' ? '/ownership' : '/assessment')
                        }
                      >
                        {entry.purpose === 'OWNERSHIP_REVIEW'
                          ? 'Review ownership'
                          : 'Review assessment'}
                      </a>
                    </nav>
                  </li>
                );
              })}
            </ul>
          )}
          {state.page.nextCursor && (
            <a
              className="button secondary"
              href={'/evaluator/practice?after=' + encodeURIComponent(state.page.nextCursor)}
            >
              More assignments
            </a>
          )}
        </>
      ) : (
        <p role="status">
          {state.status === 'SIGN_IN' ? (
            <>
              Sign in to view your current practice review assignments.{' '}
              <a href="/creator/account">Go to sign in</a>
            </>
          ) : state.status === 'DENIED' ? (
            'Practice review assignments are unavailable for your account.'
          ) : state.status === 'RATE_LIMITED' ? (
            'Too many requests. Wait a moment, then refresh assignments.'
          ) : (
            'Practice review assignments are currently unavailable. Try refreshing later.'
          )}
        </p>
      )}
      <form method="get" action="/evaluator/practice">
        <button className="button secondary" type="submit">
          Refresh assignments
        </button>
      </form>
    </div>
  );
}
