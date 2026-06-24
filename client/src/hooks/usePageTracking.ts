import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useIsMobile } from "./useMobile";

/**
 * Hook to track page views and connection events
 * Records: IP, device type, referrer, user agent, and connection activity
 */
export function usePageTracking() {
  const isMobile = useIsMobile();
  const sessionIdRef = useRef<string>("");
  const [hasTrackedPageView, setHasTrackedPageView] = useState(false);
  const recordPageViewMutation = trpc.analytics.recordPageView.useMutation();

  // Generate or retrieve session ID
  useEffect(() => {
    if (!sessionIdRef.current) {
      // Try to get from sessionStorage, or generate new
      const stored = sessionStorage.getItem("pageViewSessionId");
      if (stored) {
        sessionIdRef.current = stored;
      } else {
        sessionIdRef.current = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        sessionStorage.setItem("pageViewSessionId", sessionIdRef.current);
      }
    }
  }, []);

  // Track page view on mount
  useEffect(() => {
    if (!hasTrackedPageView && sessionIdRef.current) {
      const deviceType = isMobile ? "mobile" : "desktop";
      
      recordPageViewMutation.mutate({
        sessionId: sessionIdRef.current,
        referrer: document.referrer || undefined,
        userAgent: navigator.userAgent,
        deviceType,
        enteredToken: false,
        wasConnectedTo: false,
      });

      setHasTrackedPageView(true);
    }
  }, [hasTrackedPageView, isMobile, recordPageViewMutation]);

  /**
   * Track when user enters a 4-digit token to connect as client
   */
  const trackTokenEntry = (token: string) => {
    recordPageViewMutation.mutate({
      sessionId: sessionIdRef.current,
      referrer: document.referrer || undefined,
      userAgent: navigator.userAgent,
      deviceType: isMobile ? "mobile" : "desktop",
      enteredToken: true,
      tokenEntered: token,
      wasConnectedTo: false,
    });
  };

  /**
   * Track when this device becomes a host (generates token)
   */
  const trackHostConnection = (token: string) => {
    recordPageViewMutation.mutate({
      sessionId: sessionIdRef.current,
      referrer: document.referrer || undefined,
      userAgent: navigator.userAgent,
      deviceType: isMobile ? "mobile" : "desktop",
      enteredToken: false,
      wasConnectedTo: true,
      hostToken: token,
    });
  };

  return {
    sessionId: sessionIdRef.current,
    trackTokenEntry,
    trackHostConnection,
  };
}
