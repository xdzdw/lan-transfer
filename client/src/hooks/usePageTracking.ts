import { useCallback, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import {
  claimClientToken,
  claimHostToken,
  claimPageViewAttempt,
  silentAnalyticsMutationOptions,
} from "@/lib/pageTracking";
import { useIsMobile } from "./useMobile";

const SESSION_STORAGE_KEY = "pageViewSessionId";

function createOrReadSessionId(): string {
  if (typeof window === "undefined") return "";

  try {
    const stored = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored) return stored;

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    return sessionId;
  } catch {
    // Tracking is non-critical; keep the app usable if storage is blocked.
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}

/**
 * Hook to track page views and connection events.
 * Analytics failures are intentionally non-blocking and are kept silent.
 */
export function usePageTracking() {
  const isMobile = useIsMobile();
  const sessionIdRef = useRef<string>(createOrReadSessionId());
  const pageViewAttemptedRef = useRef(false);
  const hostTokenTrackedRef = useRef<string | null>(null);
  const clientTokensTrackedRef = useRef<Set<string>>(new Set());
  const { mutate: recordPageView } = trpc.analytics.recordPageView.useMutation(
    silentAnalyticsMutationOptions
  );

  const buildPayload = useCallback(
    (overrides: {
      enteredToken: boolean;
      tokenEntered?: string;
      wasConnectedTo: boolean;
      hostToken?: string;
    }) => ({
      sessionId: sessionIdRef.current,
      referrer: document.referrer || undefined,
      userAgent: navigator.userAgent,
      deviceType: isMobile ? ("mobile" as const) : ("desktop" as const),
      ...overrides,
    }),
    [isMobile]
  );

  // Track one page view per browser session. Mark the attempt before sending
  // so React Strict Mode and rerenders cannot submit duplicates.
  useEffect(() => {
    if (
      !claimPageViewAttempt(pageViewAttemptedRef) ||
      !sessionIdRef.current
    ) {
      return;
    }

    recordPageView(
      buildPayload({
        enteredToken: false,
        wasConnectedTo: false,
      })
    );
  }, [buildPayload, recordPageView]);

  /** Track when the user enters a 4-digit token as a client. */
  const trackTokenEntry = useCallback(
    (token: string) => {
      if (!claimClientToken(clientTokensTrackedRef.current, token)) return;

      recordPageView(
        buildPayload({
          enteredToken: true,
          tokenEntered: token,
          wasConnectedTo: false,
        })
      );
    },
    [buildPayload, recordPageView]
  );

  /** Track when this device becomes a host for a newly generated room token. */
  const trackHostConnection = useCallback(
    (token: string) => {
      if (!claimHostToken(hostTokenTrackedRef, token)) return;

      recordPageView(
        buildPayload({
          enteredToken: false,
          wasConnectedTo: true,
          hostToken: token,
        })
      );
    },
    [buildPayload, recordPageView]
  );

  return {
    sessionId: sessionIdRef.current,
    trackTokenEntry,
    trackHostConnection,
  };
}
