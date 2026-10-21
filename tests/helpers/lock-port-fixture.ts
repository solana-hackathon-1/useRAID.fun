export function fixtureAdvisoryKey(label: string) {
  let key = 17n;
  for (const char of label) key = BigInt.asIntN(64, key * 31n + BigInt(char.charCodeAt(0)));
  return key.toString();
}
/** Protocol-only responses for deterministic alternate-port domain tests. Real locks use PG tests. */
export function protocolFixture(
  sql: string,
  bindings: readonly string[],
  account: { id: string; suspended: boolean } | null,
  primary?: string | null,
): unknown[] | undefined {
  if (sql.includes('hashtextextended')) {
    return [{ key: fixtureAdvisoryKey(bindings[0]) }];
  }
  if (sql.includes('txid_current')) return [{ id: '42' }];
  if (sql.startsWith('SELECT "id", "xId"')) return account ? [{ id: account.id, xId: null }] : [];
  if (sql.startsWith('SELECT "address" FROM "WalletLink"')) return [];
  if (sql.includes('AS "accountId" FROM') && !sql.includes('UNION')) return [];
  if (
    !sql.includes('FROM "User"') &&
    /SELECT "(?:id|stateHash|userId|tokenHash|address)" FROM .* FOR (?:SHARE|UPDATE)$/.test(sql)
  )
    return [];
  if (sql === 'SELECT "address" FROM "WalletIdentity" WHERE "userId" = $1' && primary !== undefined)
    return primary ? [{ address: primary }] : [];
  return undefined;
}
