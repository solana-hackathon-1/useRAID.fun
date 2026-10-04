import { Discovery } from '@/components/discovery';
import { getRaids } from '@/lib/data';
import { config } from '@/lib/config';
import { launchDiscovery } from '@/lib/meteora/view';
import { meteoraLaunchSwitch } from '@/lib/meteora/config';
export const dynamic = 'force-dynamic';
export default async function Home() {
  return (
    <Discovery
      raids={await getRaids()}
      demo={config.demo}
      launches={config.demo ? [] : await launchDiscovery()}
      launchesOpen={meteoraLaunchSwitch()}
    />
  );
}
