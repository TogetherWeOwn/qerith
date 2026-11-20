export function validateName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('Invalid entry name');
  let bytes = 0;
  let meaningful = false;
  for (const character of name) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > 255 || character === '/' || code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
      throw new TypeError('Invalid entry name');
    }
    if (character !== ' ' && character !== '.') meaningful = true;
  }
  if (!meaningful) throw new TypeError('Invalid entry name');
}
