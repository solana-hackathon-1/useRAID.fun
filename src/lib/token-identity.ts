type IdentityToken = {
  name: string;
  symbol: string;
  imageUri: string | null;
  metadataSource: string;
} | null;
export const verifiedToken = (token: IdentityToken | undefined) =>
  token?.metadataSource === 'MARKET' ? token : null;
export function displayIdentity(raid: {
  title: string;
  projectName: string;
  projectSymbol: string;
  imageUri: string | null;
  token?: IdentityToken;
}) {
  const verified = verifiedToken(raid.token);
  return {
    name: verified?.name || raid.projectName,
    symbol: verified?.symbol || raid.projectSymbol || raid.title.slice(0, 2).toUpperCase(),
    imageUri: raid.imageUri || verified?.imageUri || null,
  };
}
