/** Source of the canonical lowercase uuid pattern, unanchored so callers can embed it in a larger expression. */
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const EXACT = new RegExp(`^${UUID_PATTERN}$`);
/** True only for a canonical lowercase uuid. */
export function isLowercaseUuid(value: string) {
  return EXACT.test(value);
}
