export interface BlockingObservation {
  query: string;
  blockers: number[];
}
/** Both the activity statement and blocking relationship must belong to the observation. */
export function matchesBlockingObservation(
  row: BlockingObservation | undefined,
  blocker: number,
  statement: RegExp,
) {
  return row !== undefined && row.blockers.includes(blocker) && row.query.search(statement) !== -1;
}
