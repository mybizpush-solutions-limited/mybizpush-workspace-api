// The password policy, shared with Hyparrow so staff meet one rule everywhere:
// at least 12 characters, with an upper-case letter, a lower-case letter, a
// digit and a symbol. Length counts characters, not UTF-16 units, so an emoji
// is one character. The UI mirrors this in ui/src/lib/passwordPolicy.ts as a
// hint only — this is the copy that decides.

export const PASSWORD_MIN_LENGTH = 12;

const RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: `at least ${PASSWORD_MIN_LENGTH} characters`, test: (p) => Array.from(p).length >= PASSWORD_MIN_LENGTH },
  { label: "an upper-case letter", test: (p) => /\p{Lu}/u.test(p) },
  { label: "a lower-case letter", test: (p) => /\p{Ll}/u.test(p) },
  { label: "a number", test: (p) => /\p{Nd}/u.test(p) },
  { label: "a symbol", test: (p) => /[\p{P}\p{S}\s]/u.test(p) },
];

// Every unmet rule, so the user can fix them all in one go.
export function passwordPolicyFailures(password: string): string[] {
  return RULES.filter((r) => !r.test(password)).map((r) => r.label);
}

export function meetsPasswordPolicy(password: string): boolean {
  return passwordPolicyFailures(password).length === 0;
}

export function passwordPolicyMessage(failures: string[]): string {
  return `Password must contain ${failures.join(", ")}`;
}
