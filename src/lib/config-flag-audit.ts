import type { PrismaClient } from '@prisma/client';
import { db } from './db';
import { operatorLogLine } from './operator-log';
import {
  RECOGNISED_ENVIRONMENTS,
  diffFlagSnapshots,
  flagSnapshot,
  type ConfigRole,
  type FlagSnapshot,
  type FlagValue,
} from '../config-validation';

/**
 * Root host for the configuration flag-change audit (DEC-2026-11-13-01, T037-W03). After the validator passes, each web
 * and worker process compares its flag snapshot with the latest recorded one for its environment and process kind
 * and appends one `ConfigFlagChange` row per changed flag. The first start of an environment and process kind records
 * a baseline as `INITIAL_OBSERVATION`. A transaction table lock (SHARE ROW EXCLUSIVE; no advisory key, which the identity-lock architecture scan restricts) makes concurrent
 * replicas record a change once. Only flag names and the words true/false/unset/invalid are stored.
 *
 * With `RAID_ENVIRONMENT=production` a failed write throws `CONFIG_AUDIT_FAILED` (web exits 1, the worker's start
 * fails); elsewhere a code-plus-class line is logged and the process continues. The actor is always
 * `deployment, unattributed`: a deployment cannot yet name the person who changed a flag.
 */
export const CONFIG_FLAG_ACTOR = 'deployment, unattributed';
const DEPLOYMENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;

type Env = Readonly<Record<string, string | undefined>>;
type AuditClient = Pick<PrismaClient, '$transaction'>;

export const auditEnvironment = (env: Env) => {
  const value = (env.RAID_ENVIRONMENT ?? '').trim().toLowerCase();
  return value === ''
    ? 'undeclared'
    : RECOGNISED_ENVIRONMENTS.includes(value)
      ? value
      : 'unrecognised';
};

async function record(client: AuditClient, role: ConfigRole, env: Env) {
  const environment = auditEnvironment(env);
  const raw = (env.RAID_DEPLOYMENT_ID ?? '').trim();
  const deploymentId = DEPLOYMENT_ID.test(raw) ? raw : null;
  // Value-free: the rejected text itself is never logged.
  if (raw !== '' && deploymentId === null)
    console.warn(JSON.stringify({ config: 'deployment-id-ignored', role }));
  const next = flagSnapshot(env);
  return client.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      // SHARE ROW EXCLUSIVE conflicts with itself and with inserts, never with plain reads: concurrent replicas
      // queue here (a startup-only, tiny table), so the second one sees the first one's rows and records nothing.
      await tx.$executeRaw`LOCK TABLE "ConfigFlagChange" IN SHARE ROW EXCLUSIVE MODE`;
      const latest = await tx.$queryRaw<{ flagName: string; newValue: FlagValue }[]>`
        SELECT DISTINCT ON ("flagName") "flagName", "newValue" FROM "ConfigFlagChange"
        WHERE "environment" = ${environment} AND "processKind" = ${role}
        ORDER BY "flagName", "id" DESC`;
      const previous: FlagSnapshot | null = latest.length
        ? Object.fromEntries(latest.map((row) => [row.flagName, row.newValue]))
        : null;
      const changes = diffFlagSnapshots(previous, next);
      if (changes.length)
        await tx.configFlagChange.createMany({
          data: changes.map((change) => ({
            environment,
            processKind: role,
            flagName: change.flag,
            previousValue: change.previous,
            newValue: change.next,
            kind: change.kind,
            deploymentId,
            actor: CONFIG_FLAG_ACTOR,
          })),
        });
      return changes.length;
    },
    { maxWait: 10000, timeout: 20000 },
  );
}

/** Returns what was recorded; `failed` only outside production. Throws `CONFIG_AUDIT_FAILED` in production. */
export async function auditConfigFlags(
  role: ConfigRole,
  env: Env = process.env,
  client: AuditClient = db,
): Promise<{ recorded: number; failed?: true }> {
  try {
    return { recorded: await record(client, role, env) };
  } catch (error) {
    // Code plus safe class only (DEC-2026-11-07-01 d): never the message, which may carry connection details.
    console.error(operatorLogLine('config-flag-audit-failed', error, { role }));
    if ((env.RAID_ENVIRONMENT ?? '').trim().toLowerCase() === 'production')
      throw Object.assign(new Error('The configuration flag audit could not be written.'), {
        code: 'CONFIG_AUDIT_FAILED',
      });
    return { recorded: 0, failed: true };
  }
}

/** Web entry: production exits with code 1 at start instead of serving without an audit trail. */
export async function auditConfigFlagsOrExit(
  role: ConfigRole,
  env: Env = process.env,
  client: AuditClient = db,
  exit: (code: number) => never = process.exit,
) {
  // A demo web process is read-only and may have no database; the audit is for real deployments.
  if (role === 'web' && env.DEMO_MODE === 'true') return { recorded: 0, skipped: true as const };
  try {
    return await auditConfigFlags(role, env, client);
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'CONFIG_AUDIT_FAILED') throw error;
    return exit(1);
  }
}
