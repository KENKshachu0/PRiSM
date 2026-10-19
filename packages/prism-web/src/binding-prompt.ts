/**
 * The shop-authored instructions a player follows to bind a platform identity.
 * Each line is plain text; a line holding `{code}` is the command to send and
 * is shown as copyable text. Older shops stored free contact text without a
 * placeholder, so that text is kept and the standard command follows it.
 */
export type BindingPromptLine = { text: string; command: boolean };

export const defaultBindingCommand = (code: string) => `bind ${code}`;

/** `null` means the shop wrote nothing and the standard wording applies. */
export function bindingPromptLines(
  template: string | null | undefined,
  code: string,
): BindingPromptLine[] | null {
  const lines = (template ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const rendered = lines.map((line) =>
    line.includes("{code}")
      ? { text: line.split("{code}").join(code), command: true }
      : { text: line, command: false },
  );
  return rendered.some((line) => line.command)
    ? rendered
    : [...rendered, { text: defaultBindingCommand(code), command: true }];
}
