// Remote hosts allowed to serve token and profile images; also the img-src of the CSP.
export const IMAGE_HOSTS = [
  'pbs.twimg.com',
  'abs.twimg.com',
  'cdn.dexscreener.com',
  'dd.dexscreener.com',
  'ipfs.io',
  'gateway.pinata.cloud',
  'pump.mypinata.cloud',
  'cf-ipfs.com',
];
export function allowedImageUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      IMAGE_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
}
