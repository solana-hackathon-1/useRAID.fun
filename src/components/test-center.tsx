'use client';

/* eslint-disable @next/next/no-html-link-for-pages -- Framework-independent component; hosts supply normal URL routing, including the independently installed React consuming example. */

import { useState, type ReactNode, type FormEvent } from 'react';
import { parseAmount, formatAmount, splitProportional } from '../asset-registry/amounts';
import { AssetRegistryError } from '../asset-registry/errors';
import { STATES, consumesCapacity, type EngagementState } from '../contracts/states';

type Coverage = 'browser' | 'backend' | 'mixed';
const issues: {
  title: string;
  issue?: number;
  coverage: Coverage;
  status: string;
  description: string;
  checks: string[];
  href?: string;
  action?: string;
}[] = [
  {
    title: 'Legacy Creator Studio',
    coverage: 'browser',
    status: 'Interactive sandbox',
    description:
      'Existing campaign, balance, tracking, review and simulated payment screens. These flows predate the new RAID foundation.',
    checks: [
      'Enter the test Studio below. Create an X Campaign using a sample post URL.',
      'Preview the post, set a reward budget, save a draft, then fund and launch with test USDC.',
      'On the campaign page, simulate a contributor and finish the test review. Inspect the public Raid and confirm the test payment in Admin.',
    ],
    href: '/creator',
    action: 'Open Creator Studio',
  },
  {
    title: 'T001 · Legacy behavior inventory',
    issue: 43,
    coverage: 'backend',
    status: 'Documentation & regression checks',
    description:
      'Inventory and preserved legacy obligations need comparison against the repository and regression evidence.',
    checks: [
      'Use the Studio flow as a legacy regression check, not proof of the new Guild/work lifecycle.',
      'Inspect docs/tasks/T001-inventory.md and the T001 criterion evidence before task acceptance.',
    ],
  },
  {
    title: 'T002 · Shared domain contracts',
    issue: 44,
    coverage: 'mixed',
    status: 'Read-only explorer',
    description:
      'Try the canonical engagement-state and amount helpers below. Selecting a state does not change an engagement.',
    checks: [
      'Select UNDER_REVIEW: the active slot stays held. Select ACCEPTED: it is released independently of payment.',
      'Automated contract and independent-host tests cover DTO validation and ownership; this explorer does not prove database capacity enforcement.',
    ],
    href: '#capacity-explorer',
    action: 'Explore capacity states',
  },
  {
    title: 'T003 · Migrations & rollback',
    issue: 45,
    coverage: 'backend',
    status: 'Database verification',
    description:
      'Additive schema, backfill and restore behavior cannot be validated by clicking a product screen.',
    checks: [
      'Verify fresh migration bootstrap, repeat deploy and drift on an explicitly disposable database.',
      'Review restore and rollback evidence separately. A successful bootstrap is not proof of disaster recovery.',
    ],
  },
  {
    title: 'T004 · Fixtures & evidence',
    issue: 46,
    coverage: 'backend',
    status: 'Test-support module',
    description:
      'Reusable realistic fixtures and evidence records support automated scenarios. Studio fixtures are a separate legacy sandbox.',
    checks: [
      'Run the raid-fixtures and raid-evidence suites and the independent consuming example.',
      'Check that simulated data cannot pass production validation. Browser test checklists do not supply independent sign-off.',
    ],
  },
  {
    title: 'T005 · CI & staging foundation',
    issue: 47,
    coverage: 'backend',
    status: 'Operations checks',
    description:
      'Build, CI, container and staging evidence must refer to the exact candidate being reviewed.',
    checks: [
      'Review the named CI checks and their candidate source. Earlier green CI does not cover later edits.',
      'No live readiness or hosted-CI result is inferred from this local test center.',
    ],
  },
  {
    title: 'T006 · Canonical identity & wallet links',
    issue: 48,
    coverage: 'backend',
    status: 'Review and integration pending',
    description:
      'Storage and sign-in/link commands exist, but additional-wallet routes, revoke/session invalidation, durable audit and UI are unfinished. Wallet linking stays disabled.',
    checks: [
      'Independent B2a/B2b re-review and owner policy decisions remain open in the handoff.',
      'Use the identity-storage, wallet-link authority and linked-wallet sign-in database tests. Current Account UI covers legacy wallet/X behavior only.',
      'Do not treat a fixture login as proof of wallet signatures, connected-X session authority or same-participant capacity.',
    ],
  },
  {
    title: 'T019 · Command receipts',
    issue: 61,
    coverage: 'backend',
    status: 'Transactional module',
    description:
      'Same-command replay, payload conflicts and transaction rollback are implemented as a reusable backend boundary.',
    checks: [
      'Run the command-receipts database and independent-host suites.',
      'Repeat the same key and payload, then reuse the key with a different payload: the first replays; the second conflicts. No new receipt command is exposed by this page.',
    ],
  },
  {
    title: 'T029 · Exact assets & amounts',
    issue: 71,
    coverage: 'mixed',
    status: 'Read-only explorer',
    description:
      'Exercise real bounded integer parsing and proportional splits below. This does not configure an asset registry or enable payments.',
    checks: [
      'Try 250.50 with six decimals, then 0.0000001 to test rejected precision.',
      'Try one base unit split across 1, 1, 1. The first recipient receives the remainder.',
      'Network/mint substitution, policy history and registry persistence need the asset-registry database suites. O07 production asset policy stays unresolved.',
    ],
    href: '#amount-explorer',
    action: 'Explore exact amounts',
  },
];

function AmountExplorer() {
  const [amount, setAmount] = useState('250.50');
  const [decimals, setDecimals] = useState('6');
  const [weights, setWeights] = useState('60, 30, 10');
  const [result, setResult] = useState<{
    base: string;
    display: string;
    shares: string;
    residual: string;
  } | null>(null);
  const [error, setError] = useState('');
  function calculate(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    setError('');
    try {
      const base = parseAmount(amount, Number(decimals));
      const parts = weights.split(',').map((weight) => weight.trim());
      if (parts.length > 16 || !parts.every((weight) => /^\d{1,20}$/.test(weight)))
        throw new AssetRegistryError('INVALID_ALLOCATION');
      const split = splitProportional(
        base,
        parts.map((weight) => BigInt(weight)),
      );
      setResult({
        base: base.toString(),
        display: formatAmount(base, Number(decimals)),
        shares: split.shares.join(', '),
        residual: split.residual.toString(),
      });
    } catch (cause) {
      const code = cause instanceof AssetRegistryError ? cause.code : 'INVALID_AMOUNT';
      const explanation =
        code === 'EXCESS_PRECISION'
          ? 'Too many fractional digits for this precision. Nothing was rounded.'
          : code === 'AMOUNT_OVERFLOW'
            ? 'Amount exceeds the unsigned 64-bit bound.'
            : code === 'INVALID_ALLOCATION'
              ? 'Use up to 16 nonnegative integer weights separated by commas, with at least one positive weight.'
              : 'Enter a nonnegative decimal amount without an exponent or separators.';
      setError(`${code} · ${explanation}`);
    }
  }
  return (
    <section id="amount-explorer" aria-labelledby="amount-heading" className="test-panel">
      <span className="test-eyebrow">T029 / T002 · Actual pure helpers</span>
      <h2 id="amount-heading">Exact amount explorer</h2>
      <p>Example precision only. No mint verification, balances or transfers.</p>
      <form onSubmit={calculate}>
        <label>
          Display amount
          <input
            value={amount}
            maxLength={100}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Asset decimals
          <select value={decimals} onChange={(e) => setDecimals(e.target.value)}>
            <option value="0">0 decimals</option>
            <option value="6">6 decimals</option>
            <option value="9">9 decimals</option>
          </select>
        </label>
        <label>
          Split weights
          <input value={weights} maxLength={350} onChange={(e) => setWeights(e.target.value)} />
        </label>
        <p className="test-note">
          Largest remainder rule; ties go to the first recipient. Weights are examples, not an
          agreed payout split.
        </p>
        <button className="button" type="submit">
          Calculate exact amounts
        </button>
      </form>
      {error && (
        <p role="alert" className="test-error">
          {error}
        </p>
      )}
      {result && (
        <div role="status" className="test-result">
          <dl>
            <div>
              <dt>Integer base units</dt>
              <dd data-testid="base-units">{result.base}</dd>
            </div>
            <div>
              <dt>Exact display value</dt>
              <dd>{result.display}</dd>
            </div>
            <div>
              <dt>Split in base units</dt>
              <dd data-testid="split-units">{result.shares}</dd>
            </div>
            <div>
              <dt>Unallocated base units</dt>
              <dd>{result.residual}</dd>
            </div>
          </dl>
        </div>
      )}
    </section>
  );
}

function CapacityExplorer() {
  const [state, setState] = useState<EngagementState>('UNDER_REVIEW');
  const held = consumesCapacity(state);
  return (
    <section id="capacity-explorer" aria-labelledby="capacity-heading" className="test-panel">
      <span className="test-eyebrow">T002 · Canonical state vocabulary</span>
      <h2 id="capacity-heading">Capacity state explorer</h2>
      <p>Inspect the shared helper. This does not accept work or reserve a slot.</p>
      <label>
        Engagement state
        <select value={state} onChange={(e) => setState(e.target.value as EngagementState)}>
          {STATES.engagement.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <div role="status" className="test-result">
        <strong>{held ? 'Active slot held' : 'Active slot released'}</strong>
        <p>
          {held
            ? 'Setup, work, review and revisions still consume capacity.'
            : 'Operational closure frees capacity. Payment may still be pending.'}
        </p>
      </div>
      {!held && <p>Payment may still be pending.</p>}
      <p className="test-note">
        The server and database enforce the one-active-Raid rule. This selector proves only the
        state helper; real concurrent acceptance remains a separate test.
      </p>
    </section>
  );
}

/** v1 presentation boundary: no app singleton, credentials, fetch or business writes. */
export function TestCenter({ sandbox, children }: { sandbox: boolean; children?: ReactNode }) {
  const [filter, setFilter] = useState<'all' | 'browser' | 'backend'>('all');
  const visible = issues.filter(
    (issue) => filter === 'all' || issue.coverage === filter || issue.coverage === 'mixed',
  );
  return (
    <div className="test-center">
      <header className="test-hero">
        <span className="test-eyebrow">RAID · Local verification workspace</span>
        <h1>Implementation test center</h1>
        <p>
          Try the screens that exist. Inspect the contracts behind them. See what still needs
          backend verification.
        </p>
        <div className="test-mode">
          {sandbox
            ? 'Isolated Studio sandbox · Fake X posts & test USDC · No real funds'
            : 'Read-only product preview · Example data · Studio actions unavailable'}
        </div>
        <p className="test-note">
          Coverage from the local checkout as of 10 October 2026. These labels describe test access,
          not issue completion or release approval.
        </p>
      </header>
      {sandbox ? (
        <section className="test-start" aria-label="Start a Studio test">
          <div>
            <h2>Start with a complete campaign flow</h2>
            <p>
              Enter the fixture account, then create a campaign, review contributions and simulate
              payment.
            </p>
          </div>
          {children}
          <div className="test-links">
            <a href="/creator/new">Create a test campaign</a>
            <a href="/creator/balance">Open test balance</a>
            <a href="/creator/account">Open account</a>
            <a href="/admin">Open test Admin</a>
            <a href="/">Open discovery</a>
          </div>
          <details>
            <summary>Sample campaign & expected results</summary>
            <ol>
              <li>Enter test Creator Studio. Choose Create Raid → X Campaign.</li>
              <li>
                Use <code>https://x.com/project/status/123456789123456789</code> and click Preview.
                The sandbox supplies a fake public post.
              </li>
              <li>
                Set reward budget to 2.5 test USDC. Expect a target of 2,500 impressions. Save a
                draft, then fund and launch.
              </li>
              <li>
                Use the campaign’s test controls to simulate a contributor and finish review. Expect
                allocation, then inspect the report and public Raid.
              </li>
              <li>
                Open test Admin and confirm the test payment. Inspect the paid state in Studio.
              </li>
            </ol>
            <p>
              These are legacy campaign checks. They do not verify new Guild, engagement, escrow or
              wallet-link contracts.
            </p>
          </details>
        </section>
      ) : (
        <section className="test-start">
          <h2>Product preview</h2>
          <p>
            The explorers below work without a database. For campaign creation and simulated
            payments, run the isolated Studio preview and open this same route there.
          </p>
          <a className="button secondary" href="/">
            Open example discovery
          </a>
        </section>
      )}
      <div className="test-section-heading">
        <div>
          <span className="test-eyebrow">Implementation coverage</span>
          <h2>Choose what to test</h2>
        </div>
        <div className="test-filters" role="group" aria-label="Filter test coverage">
          {(['all', 'browser', 'backend'] as const).map((value) => (
            <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === 'all'
                ? 'All checks'
                : value === 'browser'
                  ? 'Browser checks'
                  : 'Backend checks'}
            </button>
          ))}
        </div>
      </div>
      <div className="test-cards">
        {visible.map((issue) => (
          <article className="test-panel" key={issue.title}>
            <span className="test-badge">{issue.status}</span>
            <h3>{issue.title}</h3>
            <p>{issue.description}</p>
            <details>
              <summary>How to verify</summary>
              <ol>
                {issue.checks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ol>
              {issue.issue && (
                <a href={`https://github.com/solana-hackathon-1/useRAID.fun/issues/${issue.issue}`}>
                  View tracked issue #{issue.issue}
                </a>
              )}
            </details>
            {issue.href && (issue.coverage !== 'browser' || sandbox) && (
              <a className="test-action" href={issue.href}>
                {issue.action} →
              </a>
            )}
          </article>
        ))}
      </div>
      <div className="test-explorers">
        <AmountExplorer />
        <CapacityExplorer />
      </div>
      <aside className="test-limits">
        <h2>What this UI cannot verify</h2>
        <p>
          Database races, restore correctness, receipt persistence, cryptographic authentication and
          live chain finality need their recorded automated or independent tests. Additional-wallet
          linking stays disabled while review, revoke/audit integration and owner decisions are
          pending. No UI action here enables it.
        </p>
      </aside>
    </div>
  );
}
