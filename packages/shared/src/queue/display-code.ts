/** "A" + 23 → "A-023". Numbers reset daily, so three digits cover a normal day; more just grow. */
export function formatDisplayCode(prefix: string, number: number): string {
  if (!Number.isInteger(number) || number < 1) {
    throw new RangeError("ticket numbers start at 1");
  }
  return `${prefix}-${String(number).padStart(3, "0")}`;
}
