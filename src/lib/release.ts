import { HttpError } from './auth-primitives';

// Launchpads and their financial flows are deferred from the standalone Raid release.
export const launchpadsAvailable = false;

export function assertLaunchpadsAvailable(message = 'Launchpads are coming soon.') {
  if (!launchpadsAvailable) throw new HttpError(503, message);
}
