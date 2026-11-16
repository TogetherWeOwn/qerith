/** Validate a single HTTP byte range without interpreting the object's size. */
export function validateRange(value: string): string {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || match[0] !== value || (!match[1] && !match[2])) throw new Error('Invalid byte range');

  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) ||
      (last !== undefined && !Number.isSafeInteger(last)) ||
      (first === undefined && last === 0) ||
      (first !== undefined && last !== undefined && first > last)) {
    throw new Error('Invalid byte range');
  }
  return `bytes=${match[1]}-${match[2]}`;
}
