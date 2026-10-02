import { config } from './config';
export function studioSandbox() {
  try {
    return (
      process.env.NODE_ENV === 'development' &&
      process.env.STUDIO_SANDBOX === 'true' &&
      new URL(process.env.DATABASE_URL!).pathname === '/useraid_studio_test' &&
      ['localhost', '127.0.0.1'].includes(new URL(config.appUrl).hostname)
    );
  } catch {
    return false;
  }
}
export const sessionCookie = () => studioSandbox() ? 'raid_studio_session' : process.env.METEORA_NETWORK === 'devnet' ? 'raid_meteora_devnet_session' : 'raid_session';
