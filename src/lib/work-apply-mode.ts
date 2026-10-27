/** What the Raid brief offers the viewer; one definition for the page loader, the markup and the tests. */
export const APPLY_MODES = ['FORM', 'ACCEPT', 'SIGN_IN', 'CLOSED', 'NOT_APPLICABLE'] as const;
export type ApplyMode = (typeof APPLY_MODES)[number];
