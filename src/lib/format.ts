const numbers = new Intl.NumberFormat('en-US');
const dateTime = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

export const formatNumber = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : numbers.format(value);
export const formatUtcDateTime = (value: string | Date) =>
  `${dateTime.format(new Date(value))} UTC`;
export const formatUtcDate = (value: string | Date) => date.format(new Date(value));
