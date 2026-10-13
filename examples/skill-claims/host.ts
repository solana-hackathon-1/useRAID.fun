import assert from 'node:assert/strict';
import { prepareSkillTaxonomyUpdate, resolveSkillAlias, prepareSkillClaim } from './skills';
const frontend = {
  id: 'skill_frontend',
  domain: 'software.frontend',
  name: 'Frontend',
  status: 'ACTIVE',
  aliases: ['frontend', 'web-ui'],
};
const solana = {
  id: 'skill_solana',
  domain: 'blockchain.solana',
  name: 'Solana programs',
  status: 'ACTIVE',
  aliases: ['solana-programs'],
};
const catalog = {
  version: 'v1',
  id: 'synthetic-taxonomy',
  revision: 2,
  state: 'PUBLISHED',
  publishedByAccountId: 'synthetic-admin',
  publishedAt: '2026-10-13T12:00:00Z',
  skills: [frontend, solana],
};
const context = {
  version: 'v1',
  now: '2026-10-13T13:00:00Z',
  actorAccountId: 'synthetic-self',
  actorSessionAuthorized: true,
  actorRestricted: false,
  participant: { kind: 'HUMAN', id: 'synthetic-canonical-human', accountId: 'synthetic-self' },
  taxonomy: catalog,
};
const input = {
  skillId: frontend.id,
  claimedLevel: 'S',
  supportingReferences: ['https://public.example/portfolio'],
};
const claim = prepareSkillClaim(context, input);
assert.equal(claim.participantId, context.participant.id);
assert.equal(claim.assessedRank, null);
assert.equal(claim.verifiesSkill, false);
assert.equal(claim.persisted, false);
assert.equal(claim.confidence, null);
assert.equal(claim.sampleSize, 0);
assert.equal(resolveSkillAlias(catalog, ' WEB-UI ').skillId, frontend.id);
assert.notEqual(resolveSkillAlias(catalog, 'solana-programs').skillId, claim.skillId);
const renamed = prepareSkillTaxonomyUpdate(catalog, {
  taxonomyId: catalog.id,
  expectedRevision: 2,
  skills: [
    { ...frontend, name: 'Web interfaces', aliases: [...frontend.aliases, 'web-interfaces'] },
    solana,
  ],
});
assert.equal(renamed.taxonomy.revision, 3);
assert.equal(renamed.publishesTaxonomy, false);
assert(renamed.taxonomy.skills[0].aliases.includes('web-ui'));
assert.throws(
  () =>
    prepareSkillTaxonomyUpdate(catalog, {
      taxonomyId: catalog.id,
      expectedRevision: 2,
      skills: [{ ...frontend, domain: solana.domain }, solana],
    }),
  /HISTORY_CONFLICT/,
);
assert.throws(
  () => prepareSkillClaim(context, { ...input, tokenBalance: '100000000000000000' }),
  /INVALID_INPUT/,
);
assert.throws(
  () => prepareSkillClaim({ ...context, actorAccountId: 'foreign' }, input),
  /FORBIDDEN/,
);
console.log(
  JSON.stringify({
    synthetic: true,
    ownInstalledHost: true,
    stableSkillAndAliasIdentity: true,
    crossDomainDistinct: true,
    canonicalParticipantPreserved: true,
    noRankFromClaimOrWealth: true,
    noTaxonomyPublication: true,
    noAssessmentOrPersistence: true,
  }),
);
