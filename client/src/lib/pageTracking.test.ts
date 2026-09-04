import { describe, expect, it } from "vitest";
import {
  claimClientToken,
  claimHostToken,
  claimPageViewAttempt,
  silentAnalyticsMutationOptions,
} from "./pageTracking";

describe("page tracking safeguards", () => {
  it("allows only one page-view attempt per session", () => {
    const ref = { current: false };

    expect(claimPageViewAttempt(ref)).toBe(true);
    expect(claimPageViewAttempt(ref)).toBe(false);
    expect(ref.current).toBe(true);
  });

  it("does not track the same host token twice", () => {
    const ref = { current: null as string | null };

    expect(claimHostToken(ref, "1234")).toBe(true);
    expect(claimHostToken(ref, "1234")).toBe(false);
    expect(claimHostToken(ref, "12")).toBe(false);
    expect(claimHostToken(ref, "5678")).toBe(true);
  });

  it("does not track the same client token twice", () => {
    const tokens = new Set<string>();

    expect(claimClientToken(tokens, "1234")).toBe(true);
    expect(claimClientToken(tokens, "1234")).toBe(false);
    expect(claimClientToken(tokens, "abcd")).toBe(false);
  });

  it("marks analytics mutations as silent and retryable", () => {
    expect(silentAnalyticsMutationOptions).toEqual({
      retry: 1,
      meta: { silentAnalytics: true },
    });
  });
});
