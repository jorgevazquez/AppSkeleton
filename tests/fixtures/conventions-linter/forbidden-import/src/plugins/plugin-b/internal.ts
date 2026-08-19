/** Private to plugin-b — `plugin-a`'s import of this file is the violation under test. */
export function secret(): string {
  return "plugin-b's internal secret";
}
