/** Detect ASCII control characters without accepting hidden command identities. */
export function hasAsciiControlCharacters(value, allowWhitespace = false) {
  for (const character of String(value)) {
    const code = character.charCodeAt(0);
    if (code < 32 && (!allowWhitespace || ![9, 10].includes(code))) return true;
  }
  return false;
}
