// Scan already-valid JSON; a string followed by a colon is an object member.
// Decode member names so different escape spellings cannot hide a duplicate.
export function hasDuplicateMembers(text) {
  const objects = [];
  for (const [token, key, colon] of text.matchAll(/("(?:[^"\\]|\\.)*")([ \t\r\n]*:)?|[{}]/gs)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (colon) {
      const keys = objects.at(-1), name = JSON.parse(key);
      if (keys.has(name)) return true;
      keys.add(name);
    }
  }
  return false;
}
