/** Where the account page may send a person back to after signing in. Paths only, never another site. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BRIEF = new RegExp(`^/raids/work/(${UUID})$`);
export interface AccountReturn {
  href: string;
  label: string;
  /** The X sign-in return token (see `x-oauth-routes`), so signing in through X comes back too. */
  oauth?: string;
}
/** The sign-in link for a page, carrying that page as the return path. */
export function signInHref(returnTo: string) {
  return `/creator/account?returnTo=${encodeURIComponent(returnTo)}`;
}
/** A recognised return path, or null. A Raid brief is matched by its exact id only. */
export function accountReturn(value: string | string[] | undefined): AccountReturn | null {
  if (typeof value !== 'string' || !value) return null;
  const brief = BRIEF.exec(value);
  if (brief) return { href: value, label: 'Return to Raid', oauth: `work:${brief[1]}` };
  if (value.startsWith('/creator/') && !value.includes('//') && !value.includes('\\'))
    return { href: value, label: 'Return to draft' };
  return null;
}
