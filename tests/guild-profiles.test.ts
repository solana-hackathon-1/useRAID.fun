import { expect, it } from 'vitest';
import {
  prepareGuildProfileDraft,
  projectPublicGuildProfile,
  evaluateGuildProfilePermission,
} from '../src/guild-profiles';
const publicProfile = {
  id: 'guild-1',
  slug: 'synthetic-guild',
  name: 'Synthetic Guild',
  description: 'Approved public description',
  primaryToken: null,
};
const guild = { id: 'guild-1', founderAccountId: 'founder-1', revision: 2, primaryToken: null };
const facts = {
  version: 'v1',
  guild,
  founderControlVerified: true,
  actorAccountId: 'founder-1',
  actorSessionAuthorized: true,
  actorRestricted: false,
  holderEligible: false,
  now: '2026-10-13T00:00:00.000Z',
  grants: [],
};
const request = {
  guildId: 'guild-1',
  expectedRevision: 2,
  action: 'EDIT_PROFILE',
  fields: ['name'],
};
const grant = {
  id: 'grant-1',
  guildId: 'guild-1',
  granteeAccountId: 'editor-1',
  status: 'ACTIVE',
  fields: ['name'],
  canDelegateProfile: false,
  validFrom: '2026-10-12T00:00:00.000Z',
  expiresAt: '2026-10-14T00:00:00.000Z',
};
it('prepares only self-described public draft fields with no founder/token/permission side effect', () => {
  const result = prepareGuildProfileDraft({
    slug: 'synthetic-guild',
    name: ' Synthetic Guild ',
    description: ' Public draft ',
  });
  expect(result).toEqual({
    version: 'v1',
    state: 'DRAFT_PROPOSAL',
    persisted: false,
    founderControlVerified: false,
    createsPermissionGrant: false,
    profile: {
      slug: 'synthetic-guild',
      name: 'Synthetic Guild',
      description: 'Public draft',
      primaryToken: null,
    },
  });
  expect(Object.isFrozen(result)).toBe(true);
});
it.each(['founderAccountId', 'verified', 'primaryToken', 'permissions', 'privateNotes'])(
  'rejects injected draft authority/private field %s',
  (field) => {
    expect(() =>
      prepareGuildProfileDraft({
        slug: 'synthetic-guild',
        name: 'Guild',
        description: 'Draft',
        [field]: 'forged',
      }),
    ).toThrow('INVALID_INPUT');
  },
);
it('projects only approved shared public fields and never private administrators/repositories/payments/notes', () => {
  const record = {
    version: 'v1',
    guild,
    publicProfile,
    publicProfileApproved: true,
    privateContext: {
      repositories: ['private-repo'],
      notes: 'private-note',
      paymentAdmin: 'private-treasury',
      disputeContact: 'private-contact',
      grants: [grant],
    },
  };
  const projection = projectPublicGuildProfile(record);
  expect(projection).toEqual(publicProfile);
  expect(Object.isFrozen(projection)).toBe(true);
  expect(JSON.stringify(projection)).not.toMatch(/private-|grant-1|founder-1/);
});
it('rejects unapproved, foreign and success-shaped public profiles', () => {
  const base = { version: 'v1', guild, publicProfile, publicProfileApproved: true };
  for (const record of [
    { ...base, publicProfileApproved: false },
    { ...base, publicProfile: { ...publicProfile, id: 'foreign-guild' } },
    { ...base, publicProfile: { ...publicProfile, privateNotes: 'private' } },
    { ...base, guild: { ...guild, primaryToken: { mint: 'fake' } } },
  ])
    expect(() => projectPublicGuildProfile(record)).toThrow();
});
it('allows a verified own founder only within profile scopes at the current revision', () => {
  expect(evaluateGuildProfilePermission(facts, request)).toMatchObject({
    allowed: true,
    reason: 'ALLOWED',
    informational: true,
  });
  expect(
    evaluateGuildProfilePermission(facts, { ...request, action: 'DELEGATE_PROFILE' }),
  ).toMatchObject({ allowed: true });
  expect(evaluateGuildProfilePermission(facts, { ...request, expectedRevision: 1 })).toMatchObject({
    allowed: false,
    reason: 'REVISION_CHANGED',
  });
  expect(
    evaluateGuildProfilePermission(facts, { ...request, guildId: 'foreign-guild' }),
  ).toMatchObject({ allowed: false, reason: 'WRONG_GUILD' });
});
it('holder eligibility and legacy global roles never supply Guild authority', () => {
  expect(
    evaluateGuildProfilePermission(
      { ...facts, actorAccountId: 'holder-1', holderEligible: true },
      request,
    ),
  ).toMatchObject({ allowed: false, reason: 'PERMISSION_NOT_GRANTED' });
  expect(() =>
    evaluateGuildProfilePermission(
      { ...facts, actorAccountId: 'holder-1', role: 'ADMIN' },
      request,
    ),
  ).toThrow('INVALID_HOST_CONTRACT');
});
it.each([
  'TREASURY_SETTLE',
  'DISPUTE_DECIDE',
  'PRIVATE_DOWNLOAD',
  'CHANGE_FOUNDER',
  'CHANGE_PRIMARY_TOKEN',
  'SET_SKILL_RANK',
])('profile founder cannot authorize unrelated action %s', (action) => {
  expect(evaluateGuildProfilePermission(facts, { ...request, action })).toMatchObject({
    allowed: false,
    reason: 'UNSUPPORTED_ACTION',
  });
});
it.each([
  'slug',
  'primaryToken',
  'founderAccountId',
  'privateConfiguration',
  'reward',
  'permissions',
])('profile scope never authorizes unrelated or stable field %s', (field) => {
  expect(evaluateGuildProfilePermission(facts, { ...request, fields: [field] })).toMatchObject({
    allowed: false,
    reason: 'UNSUPPORTED_FIELD',
  });
});
it('requires live own authority, unrestricted actor and verified founder control', () => {
  expect(
    evaluateGuildProfilePermission({ ...facts, actorSessionAuthorized: false }, request),
  ).toMatchObject({ allowed: false, reason: 'AUTHENTICATION_REQUIRED' });
  expect(evaluateGuildProfilePermission({ ...facts, actorAccountId: null }, request)).toMatchObject(
    { allowed: false, reason: 'AUTHENTICATION_REQUIRED' },
  );
  expect(
    evaluateGuildProfilePermission({ ...facts, actorRestricted: true }, request),
  ).toMatchObject({ allowed: false, reason: 'ACCOUNT_RESTRICTED' });
  expect(
    evaluateGuildProfilePermission({ ...facts, founderControlVerified: false }, request),
  ).toMatchObject({ allowed: false, reason: 'FOUNDER_VERIFICATION_REQUIRED' });
});
it('a delegate can edit only its own granted fields and cannot redelegate without that explicit scope', () => {
  const delegated = { ...facts, actorAccountId: 'editor-1', grants: [grant] };
  expect(evaluateGuildProfilePermission(delegated, request)).toMatchObject({ allowed: true });
  expect(
    evaluateGuildProfilePermission(delegated, { ...request, fields: ['description'] }),
  ).toMatchObject({ allowed: false, reason: 'PERMISSION_NOT_GRANTED' });
  expect(
    evaluateGuildProfilePermission(delegated, { ...request, action: 'DELEGATE_PROFILE' }),
  ).toMatchObject({ allowed: false, reason: 'PERMISSION_NOT_GRANTED' });
  expect(
    evaluateGuildProfilePermission(
      { ...delegated, grants: [{ ...grant, canDelegateProfile: true }] },
      { ...request, action: 'DELEGATE_PROFILE' },
    ),
  ).toMatchObject({ allowed: true });
});
it.each([
  { guildId: 'foreign-guild' },
  { granteeAccountId: 'other-editor' },
  { status: 'REVOKED' },
  { expiresAt: '2026-10-13T00:00:00.000Z' },
  { validFrom: '2026-10-14T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z' },
])('ignores foreign, revoked, expired or future grants %j', (patch) => {
  expect(
    evaluateGuildProfilePermission(
      { ...facts, actorAccountId: 'editor-1', grants: [{ ...grant, ...patch }] },
      request,
    ),
  ).toMatchObject({ allowed: false, reason: 'PERMISSION_NOT_GRANTED' });
});
it('compares equal UTC instants across valid timestamp precisions at grant boundaries', () => {
  const delegated = { ...facts, actorAccountId: 'editor-1' };
  expect(
    evaluateGuildProfilePermission(
      { ...delegated, grants: [{ ...grant, expiresAt: '2026-10-13T00:00:00Z' }] },
      request,
    ),
  ).toMatchObject({ allowed: false, reason: 'PERMISSION_NOT_GRANTED' });
  expect(
    evaluateGuildProfilePermission(
      { ...delegated, grants: [{ ...grant, validFrom: '2026-10-13T00:00:00Z' }] },
      request,
    ),
  ).toMatchObject({ allowed: true });
});
it('rejects finer-than-millisecond grant clocks rather than rounding future authority into the present', () => {
  expect(() =>
    evaluateGuildProfilePermission(
      {
        ...facts,
        actorAccountId: 'editor-1',
        grants: [{ ...grant, validFrom: '2026-10-13T00:00:00.0001Z' }],
      },
      request,
    ),
  ).toThrow('INVALID_HOST_CONTRACT');
});
it('rejects contradictory duplicate grant identities instead of combining stale and current authority', () => {
  expect(() =>
    evaluateGuildProfilePermission(
      { ...facts, actorAccountId: 'editor-1', grants: [grant, { ...grant, status: 'REVOKED' }] },
      request,
    ),
  ).toThrow('INVALID_HOST_CONTRACT');
});
it('preserves explicit profile permissions when holder eligibility is unknown', () => {
  expect(
    evaluateGuildProfilePermission(
      { ...facts, actorAccountId: 'editor-1', holderEligible: null, grants: [grant] },
      request,
    ),
  ).toMatchObject({ allowed: true });
});
