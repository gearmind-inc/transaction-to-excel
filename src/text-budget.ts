/** UTF-16 characters in a logical matrix, including its header row. */
export function countMatrixChars(headers: readonly string[], rows: readonly (readonly string[])[]): number {
  let total = headers.reduce((sum, header) => sum + header.length, 0);
  for (const row of rows) for (const value of row) total += value.length;
  return total;
}
