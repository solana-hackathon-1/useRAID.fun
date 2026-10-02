import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type AllowlistEntry = { package: string; advisory: string; reason: string; expires: string };
type AuditVia = string | { source?: number; name?: string; url?: string; severity?: string };
export type AuditReport = {
  vulnerabilities?: Record<string, { severity?: string; via?: AuditVia[] }>;
};
export type Finding = { package: string; advisory: string; severity: string; reason: string };

const failing = new Set(['moderate', 'high', 'critical']);

function advisoryId(url: string | undefined, source: number | undefined) {
  return url?.split('/').pop() || String(source);
}

export function evaluate(report: AuditReport, allowlist: AllowlistEntry[], now = new Date()) {
  const failures: Finding[] = [];
  const seen = new Set<string>();
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'string' || !via.severity || !failing.has(via.severity)) continue;
      const advisory = advisoryId(via.url, via.source);
      const key = `${name}:${advisory}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = allowlist.find((item) => item.package === name && item.advisory === advisory);
      if (!entry) {
        failures.push({
          package: name,
          advisory,
          severity: via.severity,
          reason: 'not allowlisted',
        });
      } else if (!(Date.parse(entry.expires) > now.getTime())) {
        failures.push({
          package: name,
          advisory,
          severity: via.severity,
          reason: `allowlist entry expired ${entry.expires}`,
        });
      }
    }
  }
  return failures;
}

function main() {
  const allowlist = JSON.parse(
    readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'),
  ) as AllowlistEntry[];
  const result = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  let report: AuditReport;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    console.error('npm audit did not return JSON:', result.stderr || result.stdout);
    process.exit(2);
  }
  const failures = evaluate(report, allowlist);
  for (const item of failures) {
    console.error(`${item.severity} ${item.package} ${item.advisory}: ${item.reason}`);
  }
  if (failures.length) process.exit(1);
  console.log('npm audit: every moderate-or-higher advisory is allowlisted and unexpired.');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
