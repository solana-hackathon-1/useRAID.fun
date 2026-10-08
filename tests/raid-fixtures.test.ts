import { describe, it, expect } from 'vitest';
import { createSyntheticFixtures } from './fixtures/raid';
import { assetKey, consumesCapacity, EngagementSchema, PublicGuildSchema } from '../src/contracts';

describe('T004 deterministic synthetic inputs, never domain authority', () => {
  it('is visibly synthetic, immutable and reproducible without shared mutable state', () => {
    const a = createSyntheticFixtures();
    const b = createSyntheticFixtures();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.simulation).toBe(true);
    expect(a.label).toContain('TEST ONLY');
    expect(Object.isFrozen(a.people.newcomer.skills)).toBe(true);
    expect(() => Reflect.set(a.people.newcomer, 'orientationCompleted', false)).not.toThrow();
    expect(Reflect.set(a.people.newcomer, 'orientationCompleted', false)).toBe(false);
    expect(b.people.newcomer.orientationCompleted).toBe(true);
  });
  it('separates orientation, relevant assessed skill, wealth, trust and resource rights', () => {
    const { people } = createSyntheticFixtures();
    expect(people.newcomer.orientationCompleted).toBe(true);
    expect(people.newcomer.skills).toEqual([]);
    expect(people.specialist.skills[0]).toMatchObject({
      skillId: 'test-only-frontend',
      rank: 'A',
      verified: true,
    });
    expect(people.specialist.guildRelationships).toEqual([]);
    expect(people.specialist.grantIds).toEqual([]);
    expect(people.specialist.skills.some((s) => s.skillId === 'test-only-solana')).toBe(false);
    expect(people.wealthy.skills[0]).toMatchObject({ rank: 'E', verified: false });
    expect(BigInt(people.wealthy.displayBalance)).toBeGreaterThan(0n);
  });
  it('has one canonical busy identity across two wallet links and finite frozen accepted terms', () => {
    const f = createSyntheticFixtures();
    expect(f.walletLinks).toHaveLength(2);
    expect(new Set(f.walletLinks.map((w) => w.participantId))).toEqual(
      new Set([f.people.busy.participant.id]),
    );
    expect(f.engagement.acceptedTerms.roster[0].participantId).toBe(f.people.busy.participant.id);
    expect(consumesCapacity(f.engagement.state)).toBe(true);
    expect(EngagementSchema.safeParse(f.engagement).success).toBe(true);
    expect(Object.isFrozen(f.engagement.acceptedTerms.deadlines)).toBe(true);
    expect(f.commitments[0].engagementId).toBe(f.engagement.id);
  });
  it('supplies two alternative Parties sharing a busy member, not two accepted assignments', () => {
    const f = createSyntheticFixtures();
    const shared = f.parties[0].memberIds.filter((id) => f.parties[1].memberIds.includes(id));
    expect(shared).toEqual([f.people.busy.participant.id]);
    expect(f.parties.every((p) => p.state === 'PROPOSED')).toBe(true);
    expect(f.commitments).toHaveLength(1);
  });
  it('models two agent identities and the operator human sharing one proposed engagement', () => {
    const f = createSyntheticFixtures();
    expect(new Set(f.agents.map((a) => a.operatorId))).toEqual(new Set([f.operator.id]));
    expect(new Set(f.agents.map((a) => a.id)).size).toBe(2);
    expect(f.operator.humanParticipantId).toBe(f.people.operator.participant.id);
    expect(f.operatorParty.memberIds).toEqual([
      f.operator.humanParticipantId,
      ...f.agents.map((a) => a.id),
    ]);
    expect(f.operatorParty.engagementId).toBe('test-only-operator-engagement');
  });
  it('keeps same-symbol mints, networks and policy versions distinct from display labels', () => {
    const f = createSyntheticFixtures();
    expect(f.assets[0].symbol).toBe(f.assets[1].symbol);
    expect(assetKey(f.assets[0].policy.assetId)).not.toBe(assetKey(f.assets[1].policy.assetId));
    expect(assetKey(f.assets[0].policy.assetId)).not.toBe(
      assetKey({ ...f.assets[0].policy.assetId, networkIdentity: 'test-only-other-genesis' }),
    );
    expect(f.assets.every((a) => a.policy.assetId.networkIdentity.startsWith('test-only-'))).toBe(
      true,
    );
    expect(f.rewardLegs.map((leg) => leg.fundingState)).toEqual(['VERIFIED', 'REQUIRED']);
    expect(f.rewardLegs.every((leg) => /^\d+$/.test(leg.promisedBaseUnits))).toBe(true);
    expect(f.rewardLegs[1].creditedBaseUnits).toBe('0');
  });
  it('includes new, reliable and unresolved-case Guild facts without inventing public reputation', () => {
    const f = createSyntheticFixtures();
    expect(f.guilds.map((g) => g.history)).toEqual([
      'NONE',
      'RELIABLE_SYNTHETIC',
      'UNRESOLVED_CASE',
    ]);
    for (const g of f.guilds) {
      expect(g.public.name).toContain('TEST ONLY');
      expect(PublicGuildSchema.safeParse(g.public).success).toBe(true);
    }
    expect(f.challengeEntry).toMatchObject({
      valid: true,
      selected: false,
      reliabilityFault: false,
      simulation: true,
    });
  });
  it('retains independent provider rights plus two overlapping task grant reasons', () => {
    const f = createSyntheticFixtures();
    expect(f.access.baseline.origin).toBe('INDEPENDENT');
    expect(f.access.grants).toHaveLength(2);
    expect(new Set(f.access.grants.map((g) => g.resourceId))).toEqual(
      new Set([f.access.baseline.resourceId]),
    );
    expect(f.access.grants[0]).toMatchObject({ desired: 'REVOKED', observed: 'ACTIVE' });
    expect(f.access.grants[1]).toMatchObject({ desired: 'ACTIVE', observed: 'ACTIVE' });
    expect(f.access.grants[1].generation).toBeGreaterThan(f.access.grants[0].generation);
    expect(f.access.privateCanary).toContain('TEST_ONLY_PRIVATE');
    expect(JSON.stringify(f.guilds.map((g) => g.public))).not.toContain(f.access.privateCanary);
  });
  it('preserves semantic effect identity across duplicate delivery and rebuilt signatures', () => {
    const f = createSyntheticFixtures();
    expect(new Set(f.duplicateEffects.map((e) => e.operationId)).size).toBe(1);
    expect(new Set(f.duplicateEffects.map((e) => e.signature)).size).toBe(2);
    expect(f.duplicateEffects[0].deliveryId).not.toBe(f.duplicateEffects[1].deliveryId);
    expect(
      f.duplicateEffects.every(
        (e) => e.simulation && e.assetKey === assetKey(f.assets[0].policy.assetId),
      ),
    ).toBe(true);
    expect(f.providerScripts.map((s) => s.case)).toEqual([
      'LATE_BINDING',
      'FAILED_REVOCATION',
      'DUPLICATE_CALLBACK',
      'INTERRUPTED_PAYOUT',
      'MALICIOUS_INSTRUCTIONS',
    ]);
    expect(f.providerScripts.every((s) => s.simulation && s.observations.length > 0)).toBe(true);
  });
});
