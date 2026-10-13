import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectProposalForm } from './components/project-proposal-form';
const id = '11111111-1111-4111-8111-111111111111';
const unused = async () => {
  throw Error('Synthetic transport unused during SSR');
};
for (const enabled of [false, true]) {
  const html = renderToStaticMarkup(
    <ProjectProposalForm
      draftRevision={1}
      state={{
        version: 'v1',
        guildDraftId: id,
        proposal: null,
        writesAvailable: enabled,
        unavailableReason: enabled ? null : 'DISABLED',
      }}
      api={{ save: unused, readProposal: unused, readDraft: unused }}
    />,
  );
  for (const value of [
    'Claimed network identity',
    'Token mint',
    'Token program',
    'Supporting reference URLs',
    'Save private proposal',
    'Founder control has not been verified.',
    'No proposal has been saved.',
  ])
    assert(html.includes(value));
  assert.equal(/<fieldset[^>]*disabled/.test(html), !enabled);
  assert(!html.includes('sessionHash'));
  assert(!html.includes('node_modules'));
  assert(!html.includes('NEXT_PUBLIC'));
}
console.log(
  JSON.stringify({
    synthetic: true,
    reusableReactForm: true,
    explicitTransport: true,
    semanticLabels: true,
    enabledDisabledSSR: true,
    noHiddenRequestsOrAuthState: true,
    noProjectAuthority: true,
  }),
);
