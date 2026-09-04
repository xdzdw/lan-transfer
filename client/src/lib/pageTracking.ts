export const silentAnalyticsMutationOptions = {
  retry: 1,
  meta: { silentAnalytics: true },
} as const;

export function claimPageViewAttempt(ref: { current: boolean }): boolean {
  if (ref.current) return false;
  ref.current = true;
  return true;
}

export function claimHostToken(
  ref: { current: string | null },
  token: string
): boolean {
  if (!/^\d{4}$/.test(token) || ref.current === token) return false;
  ref.current = token;
  return true;
}

export function claimClientToken(tokens: Set<string>, token: string): boolean {
  if (!/^\d{4}$/.test(token) || tokens.has(token)) return false;
  tokens.add(token);
  return true;
}
