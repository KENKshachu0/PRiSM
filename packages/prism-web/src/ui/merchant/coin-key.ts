/**
 * The coin action presses one key through a simulated keyboard, so the store
 * should configure a key, not a Windows Virtual-Key number. The wire protocol
 * still carries a numeric key code, so the text is mapped here in one place.
 *
 * Only unmodified keys are representable: the protocol has no modifier field,
 * so shifted symbols (for example `!`) are not addressable.
 */

const NAMED: Record<string, number> = {
  space: 32,
  enter: 13,
  tab: 9,
  backspace: 8,
  esc: 27,
  escape: 27,
};

const SYMBOLS: Record<string, number> = {
  ";": 186,
  "=": 187,
  ",": 188,
  "-": 189,
  ".": 190,
  "/": 191,
  "`": 192,
  "[": 219,
  "\\": 220,
  "]": 221,
  "'": 222,
};

/** Virtual-Key code for one typed key, or null when the text is not a key. */
export function vkFromKeyText(text: string): number | null {
  // A lone space is the space bar, not empty input.
  if (text === " ") return 32;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const named = NAMED[trimmed.toLowerCase()];
  if (named) return named;
  // A single character covers letters, digits and unshifted symbols.
  if ([...trimmed].length === 1) {
    const char = trimmed.toLowerCase();
    if (/^[a-z]$/.test(char)) return char.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(char)) return char.charCodeAt(0);
    if (SYMBOLS[trimmed]) return SYMBOLS[trimmed];
    return null;
  }
  // A bare number is still accepted as a raw Virtual-Key code.
  const code = Number(trimmed);
  return Number.isInteger(code) && code >= 1 && code <= 65535 ? code : null;
}

/** What to show for a stored key code: a readable key when one is known. */
export function keyTextFromVk(code: number | null | undefined): string {
  if (!code || code < 1) return "";
  for (const [name, value] of Object.entries(NAMED)) {
    if (value === code) return name[0]!.toUpperCase() + name.slice(1);
  }
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  if (code >= 48 && code <= 57) return String.fromCharCode(code);
  for (const [symbol, value] of Object.entries(SYMBOLS)) {
    if (value === code) return symbol;
  }
  return String(code);
}
