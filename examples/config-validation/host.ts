// Standalone consuming host for the runtime configuration validator. It supplies its own
// synthetic environments and reads no RAID config, database, process.env or provider.
import assert from 'node:assert/strict';
import {
  ConfigRefusedError,
  FLAG_CATALOG,
  assertRuntimeConfig,
  validateRuntimeConfig,
} from './config-validation/index';

// 1. A fresh process with nothing configured starts with every real operation off.
assert.deepEqual(validateRuntimeConfig({}, 'web'), { ok: true, violations: [] });
assert.ok(
  FLAG_CATALOG.every(
    (flag) => flag.defaultState === 'OFF' || flag.name === 'X_TRACKING_V2_ENABLED',
  ),
);

// 2. A real-operation switch without its authority is refused, by name only.
const payoutOnWorker = { PAYOUT_ENABLED: 'true', SOLANA_RPC_URL: 'http://not-https.invalid' };
assert.throws(
  () => assertRuntimeConfig(payoutOnWorker, 'worker'),
  (error) => {
    assert.ok(error instanceof ConfigRefusedError);
    assert.match(error.message, /REAL_OPERATION_AUTHORITY_MISSING\(OPERATOR_SECRET_KEY\)/);
    return true;
  },
);

// 3. A mistyped switch never silently means "on" or "off": high-impact ones are refused, routine ones warn.
assert.equal(validateRuntimeConfig({ LAUNCH_ENABLED: 'TRUE' }, 'web').ok, false);
const routine = validateRuntimeConfig({ WORK_START_ENABLED: '1' }, 'web');
assert.equal(routine.ok, true);
assert.equal(routine.violations[0]?.code, 'FLAG_VALUE_NOT_EXACT');

// 4. Test modes cannot run as production, and signer secrets cannot reach the web role.
assert.equal(
  validateRuntimeConfig({ NODE_ENV: 'production', STUDIO_SANDBOX: 'true' }, 'web').ok,
  false,
);
const leaked = validateRuntimeConfig(
  {
    LAUNCH_ENABLED: 'true',
    OPERATOR_PUBLIC_KEY: 'p',
    PLATFORM_TREASURY_ADDRESS: 't',
    SOLANA_RPC_URL: 'https://rpc.invalid',
    OPERATOR_SECRET_KEY: 'never-echoed',
  },
  'web',
);
assert.deepEqual(
  leaked.violations.map((v) => v.code),
  ['SIGNER_SECRET_ON_WEB'],
);
assert.ok(!JSON.stringify(leaked).includes('never-echoed'));

console.log('config-validation example: all checks passed');
