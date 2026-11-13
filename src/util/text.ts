/**
 * Render untrusted single-line text without letting a claim forge CLI/MCP lines.
 * Newlines, tabs and C0 control characters become visible escapes; ANSI escapes
 * are inside the control range. JSON output keeps the raw value (JSON escapes it).
 */
export function oneLine(value: string): string {
  return value
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
