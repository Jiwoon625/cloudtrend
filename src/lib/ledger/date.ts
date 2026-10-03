/** Calendar-date primitive shared without coupling model code to actual-ledger validation. */
export function validDate(date: string): boolean {
  const time = Date.parse(`${date}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === date
  );
}
