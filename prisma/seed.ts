import 'dotenv/config';
import { db } from '../src/lib/db';
async function main() {
  await db.settings.upsert({ where: { id: 'global' }, create: {}, update: {} });
  console.log(
    'Pilot settings ready. Collection defaults to paused; no fake live data was inserted.',
  );
}
main().finally(() => db.$disconnect());
