import { readFile, readdir, mkdtemp, cp, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { STATES, STATE_OWNERS, COMMANDS, GuildSchema, EventEnvelopeSchema } from '../src/contracts';

describe('T002 ownership and independent consumer boundary', () => {
  it('assigns every state family to commands of its sole owner', () => {
    expect(Object.keys(STATE_OWNERS).sort()).toEqual(Object.keys(STATES).sort());
    for (const family of Object.values(STATE_OWNERS))
      for (const command of family.commands) expect(COMMANDS[command].owner).toBe(family.owner);
  });
  it('records Guild authority independently from primary-token membership', () => {
    const guild = { id: 'guild-1', founderAccountId: 'account-1', revision: 1, primaryToken: null };
    expect(GuildSchema.parse(guild).founderAccountId).toBe('account-1');
    expect(() =>
      GuildSchema.parse({ ...guild, founderAccountId: undefined, holderEligible: true }),
    ).toThrow();
  });
  it('validates versioned identifier-only events without copying private payloads', () => {
    const event = {
      eventId: 'event-1',
      type: 'work.engagement_committed.v1',
      aggregateId: 'e-1',
      aggregateVersion: 1,
      occurredAt: '2026-10-08T00:00:00Z',
      actorId: 'a-1',
      guildId: 'g-1',
      correlationId: 'req-1',
      payload: { termsVersionId: 't-1' },
    };
    expect(EventEnvelopeSchema.parse(event).payload.termsVersionId).toBe('t-1');
    expect(() =>
      EventEnvelopeSchema.parse({ ...event, payload: { privateBrief: 'secret' } }),
    ).toThrow();
    expect(() =>
      EventEnvelopeSchema.parse({ ...event, type: 'work.engagement_committed' }),
    ).toThrow();
  });
  it('has no undeclared app/global dependencies and runs the declared host outside the app', async () => {
    const source = join(process.cwd(), 'src/contracts');
    for (const name of await readdir(source)) {
      const body = await readFile(join(source, name), 'utf8');
      expect(body).not.toMatch(/process\.env|globalThis|@\/|from ['"]\.\.\//);
    }
    const host = await mkdtemp(join(tmpdir(), 'raid-t002-consumer-'));
    try {
      await cp(source, join(host, 'contracts'), { recursive: true });
      await cp(join(process.cwd(), 'examples/shared-contracts/host.ts'), join(host, 'host.ts'));
      await cp(
        join(process.cwd(), 'examples/shared-contracts/package.json'),
        join(host, 'package.json'),
      );
      // Explicit fixture runtime supplied by the test host; standalone install is documented separately.
      await symlink(join(process.cwd(), 'node_modules'), join(host, 'node_modules'), 'dir');
      await writeFile(
        join(host, 'tsconfig.json'),
        '{"compilerOptions":{"module":"esnext","target":"es2022","strict":true}}',
      );
      const output = execFileSync(
        process.execPath,
        [join(host, 'node_modules/tsx/dist/cli.mjs'), 'host.ts'],
        {
          cwd: host,
          encoding: 'utf8',
          env: { PATH: process.env.PATH, NODE_ENV: 'test' },
          timeout: 15000,
        },
      );
      expect(JSON.parse(output)).toEqual({
        contractVersion: 'v1',
        simulation: true,
        exactReward: '250500000',
        capacityHeld: true,
        terminalCapacityHeld: false,
        privateFieldRejected: true,
        wrongSourceRejected: true,
      });
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  });
});
