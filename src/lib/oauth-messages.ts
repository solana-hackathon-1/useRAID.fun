export const oauthMessages: Record<string, string> = {
  connected: 'X account connected.',
  cancelled: 'X authorization was cancelled. You can try again.',
  state: 'Authorization expired or was invalid. Start Connect X again.',
  session: 'Your sign-in session changed or expired. Start Connect X again.',
  identity:
    'This X identity is already tied to another account with activity, or this account has a different X identity. Reconnect using your original X account, or sign in with the wallet that owns the activity.',
  suspended: 'This account is suspended.',
  provider: 'X could not complete authorization or profile lookup. Try again later.',
  unavailable: 'X connection is unavailable. Check OAuth configuration and demo mode.',
  failed: 'Could not connect X. Try again later.',
};
export function oauthMessage(code?: string) {
  return code && Object.hasOwn(oauthMessages, code) ? oauthMessages[code] : '';
}
