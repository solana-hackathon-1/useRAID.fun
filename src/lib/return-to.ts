/** Where the account page may send a person back to after signing in. Paths only, never another site. */
import { UUID_PATTERN } from './uuid-pattern';

const BRIEF = new RegExp(`^/raids/work/(${UUID_PATTERN})$`);
/**
 * A draft path must stay a plain path: no control characters, whitespace or line separators (browsers strip tab, CR and
 * LF before resolving, so `.\t.` would become `..`), no `//` or backslash, no encoded slashes, dots, NUL or double
 * encoding in the path, and no dot segments.
 */
function plainPath(value: string) {
  if (/[\u0000-\u001f\u007f\s]/.test(value) || value.includes('//') || value.includes('\\'))
    return false;
  const path = value.split(/[?#]/, 1)[0];
  if (/%(2f|5c|2e|25|00)/i.test(path)) return false;
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
  if (value.startsWith('/creator/') && plainPath(value))
    return { href: value, label: 'Return to draft' };
  return null;
}
/** The Creator Studio path to send a person back to, or null. Only a validated `/creator/` draft path qualifies. */
export function creatorReturn(value: string | string[] | undefined): string | null {
  const back = accountReturn(value);
  return back && back.href.startsWith('/creator/') ? back.href : null;
}
