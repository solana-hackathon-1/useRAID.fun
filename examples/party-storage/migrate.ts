import { execFileSync } from 'node:child_process';
import { databaseUrl } from './connection';
// `prisma db execute` runs each file as one multi-statement script: the host schema, then the repository's own
// receipt, Raid terms, capacity, admission, simulated-reservation and Party migrations, in that order.
for (const file of [
  'schema.sql',
  'migrations/receipts.sql',
  'migrations/terms.sql',
  'migrations/capacity.sql',
  'migrations/admission.sql',
  'migrations/simulated-reservations.sql',
  'migrations/reservation-binding.sql',
  'migrations/parties.sql',
])
  try {
    execFileSync(
      'npx',
      ['--no-install', 'prisma', 'db', 'execute', '--file', file, '--url', databaseUrl],
      { stdio: 'pipe', encoding: 'utf8' },
    );
  } catch (error) {
    console.error(`Migration ${file} failed:`, (error as { stderr?: string }).stderr);
    process.exit(1);
  }
console.log('Independent synthetic host tables and the owned migrations applied.');
