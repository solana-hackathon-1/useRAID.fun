/** Where the account page may send a person back to after signing in. Paths only, never another site. */
import { UUID_PATTERN } from './uuid-pattern';

const BRIEF = new RegExp(`^/raids/work/(${UUID_PATTERN})$`);
/** A draft path must stay a plain path: no dot segments, no encoded slashes, backslashes or dots, no double encoding. */
function plainPath(value: string) {
  const path = value.split(/[?#]/, 1)[0];
  if (path.includes('//') || path.includes('\\') || /%(2f|5c|2e|25)/i.test(path)) return false;
  return !path.split('/').some((segment) => segment === '.' || segment === '..');
}
/** An X sign-in return token the server resolves from a fixed table or strict id pattern, never a raw path. */
export type XReturnToken = `work:${string}` | `raid:${string}` | 'creator' | 'account' | 'admin';
export interface AccountReturn {
  href: string;
  label: string;
  /** The X sign-in return token (see `x-oauth-routes`), so signing in through X comes back too. */
  oauth?: XReturnToken;
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
  if (
    value.startsWith('/creator/') &&
    !value.includes('//') &&
    !value.includes('\\') &&
    plainPath(value)
  )
    return { href: value, label: 'Return to draft' };
  return null;
}
