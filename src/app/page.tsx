import { Discovery } from '@/components/discovery';
import { getRaids } from '@/lib/data';
import { config } from '@/lib/config';
export const dynamic = 'force-dynamic';
export default async function Home() {
  return <Discovery raids={await getRaids()} demo={config.demo} />;
}
