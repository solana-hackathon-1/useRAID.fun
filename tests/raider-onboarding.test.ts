import { describe, expect, it } from 'vitest';
import { OnboardingContractError, prepareRaiderOrientation } from '../src/raider-onboarding';

const input = {
  experience: 'BEGINNER',
  workInterests: ['qa', 'frontend'],
  timezone: 'Asia/Kathmandu',
  orientationAcknowledged: true,
};
const host = {
  version: 'v1',
  interestIds: ['frontend', 'qa'],
  nextActions: {
    starterTasks: { available: true, href: '/starter-tasks' },
    portfolio: { available: true, href: '/profile/portfolio' },
    trial: { available: true, href: '/trials' },
  },
};
const prepare = (data: unknown = input, options: unknown = host) =>
  prepareRaiderOrientation(data, options) as Record<string, unknown>;

describe('T008 reusable orientation preparation', () => {
  it('prepares a beginner route without inventing completion, rank, capacity or payment authority', () => {
    const result = prepare();
    expect(result).toMatchObject({
      version: 'v1',
      state: 'PREPARED',
      persisted: false,
      assignsVerifiedSkill: false,
      reservesCapacity: false,
      authorizesPaidCommitment: false,
      nextAction: { kind: 'STARTER_TASKS', available: true, href: '/starter-tasks' },
      preferences: {
        experience: 'BEGINNER',
        timezone: 'Asia/Kathmandu',
        workInterests: ['frontend', 'qa'],
      },
    });
    expect(result).not.toHaveProperty('rank');
  });
  it.each(['PORTFOLIO', 'TRIAL'])(
    'routes experienced newcomers directly through %s evidence',
    (evidencePath) => {
      expect(prepare({ ...input, experience: 'EXPERIENCED', evidencePath })).toMatchObject({
        nextAction: {
          kind: evidencePath,
          available: true,
          href: evidencePath === 'PORTFOLIO' ? '/profile/portfolio' : '/trials',
        },
        assignsVerifiedSkill: false,
      });
    },
  );
  it('allows a beginner to choose a relevant trial without requiring earned rank first', () => {
    expect(prepare({ ...input, evidencePath: 'TRIAL' })).toMatchObject({
      nextAction: { kind: 'TRIAL' },
      assignsVerifiedSkill: false,
    });
  });
  it('reports unavailable starter work rather than linking an unimplemented route', () => {
    expect(
      prepare(input, {
        ...host,
        nextActions: {
          ...host.nextActions,
          starterTasks: { available: false, reason: 'NOT_CONFIGURED' },
        },
      }),
    ).toMatchObject({
      nextAction: { kind: 'STARTER_TASKS', available: false, reason: 'NOT_CONFIGURED', href: null },
      authorizesPaidCommitment: false,
    });
  });
  it('accepts a host replacement without rewriting preferences or granting eligibility', () => {
    const alternate = {
      ...host,
      nextActions: { ...host.nextActions, portfolio: { available: false, reason: 'NOT_READY' } },
    };
    const original = prepare({ ...input, experience: 'EXPERIENCED' });
    const replaced = prepare({ ...input, experience: 'EXPERIENCED' }, alternate);
    expect(replaced.preferences).toEqual(original.preferences);
    expect(replaced.nextAction).toEqual({
      kind: 'PORTFOLIO',
      available: false,
      reason: 'NOT_READY',
      href: null,
    });
    expect(replaced.authorizesPaidCommitment).toBe(false);
  });
  it('retains opaque catalog identifiers from the shared InternalId contract', () => {
    const id = '02ce76fb-d125-4b07-874b-accef940b520';
    expect(
      prepare({ ...input, workInterests: [id] }, { ...host, interestIds: [id] }),
    ).toMatchObject({
      preferences: { workInterests: [id] },
    });
  });
  it('normalizes an unordered interest set without mutating caller data', () => {
    const data = { ...input, workInterests: ['qa', 'frontend', 'qa'] };
    const before = structuredClone(data);
    expect(prepare(data)).toMatchObject({ preferences: { workInterests: ['frontend', 'qa'] } });
    expect(data).toEqual(before);
  });
  it.each([
    { ...input, timezone: 'private-invalid-timezone' },
    { ...input, orientationAcknowledged: false },
    { ...input, workInterests: ['unknown-skill'] },
    { ...input, verifiedRank: 'S' },
    { ...input, admin: true },
    { ...input, portfolioUrl: 'https://private-user:private-password@example.invalid/work' },
  ])('rejects invalid or privilege-bearing input without echoing private values', (data) => {
    let error: unknown;
    try {
      prepare(data);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(OnboardingContractError);
    expect(error).toMatchObject({ code: 'INVALID_INPUT', message: 'INVALID_INPUT' });
    expect(String(error)).not.toMatch(/private|password|example\.invalid/);
  });
  it.each(['https://foreign.example/trial', '//foreign.example/trial', '/\\foreign.example/trial'])(
    'rejects an external or ambiguous host action %s',
    (href) => {
      expect(() =>
        prepare(input, {
          ...host,
          nextActions: { ...host.nextActions, starterTasks: { available: true, href } },
        }),
      ).toThrowError('INVALID_HOST_CONTRACT');
    },
  );
  it('rejects success-shaped unavailable capabilities', () => {
    expect(() =>
      prepare(input, {
        ...host,
        nextActions: {
          ...host.nextActions,
          starterTasks: { available: false, href: '/starter-tasks' },
        },
      }),
    ).toThrowError('INVALID_HOST_CONTRACT');
  });
});
