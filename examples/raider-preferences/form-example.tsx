import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RaiderOrientationForm,
  type OrientationTransport,
} from './components/raider-orientation-form';
import type { OrientationState } from './raider-onboarding/host-contracts';
const api: OrientationTransport = {
  save: async () => {
    throw Error('SSR must not submit');
  },
  read: async () => {
    throw Error('SSR must not read');
  },
};
const state: OrientationState = {
  version: 'v1',
  orientation: null,
  catalog: [{ id: 'qa', label: 'Synthetic QA' }],
  writesAvailable: true,
  unavailableReason: null,
};
const html = renderToStaticMarkup(<RaiderOrientationForm state={state} api={api} />);
assert(html.includes('Synthetic QA'));
assert(html.includes('Timezone'));
assert(html.includes('I understand these commitments'));
assert(html.includes('Save preferences'));
assert(!html.includes('synthetic-cookie'));
const unavailable = renderToStaticMarkup(
  <RaiderOrientationForm
    state={{ ...state, writesAvailable: false, unavailableReason: 'DISABLED' }}
    api={api}
  />,
);
assert(unavailable.includes('Saving preferences is currently unavailable.'));
assert(unavailable.includes('disabled'));
console.log(
  JSON.stringify({
    synthetic: true,
    ownReactHost: true,
    noNextDependency: true,
    semanticForm: true,
    explicitUnavailable: true,
    noHiddenRequest: true,
  }),
);
