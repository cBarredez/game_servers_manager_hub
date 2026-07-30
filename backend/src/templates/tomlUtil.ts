/** Escapes a string for embedding as a TOML basic string ("...") value. */
export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
