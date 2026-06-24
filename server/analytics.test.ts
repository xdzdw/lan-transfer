import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordPageView, getPageViewStats, getPageViewsByDeviceType } from "./db";

/**
 * Unit tests for page view tracking functionality
 * Tests the database operations for recording and querying page views
 */
describe("Page View Tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordPageView", () => {
    it("should record a page view without throwing", async () => {
      const pageViewData = {
        visitedAt: new Date(),
        ipAddress: "192.168.1.100",
        referrer: "https://example.com",
        userAgent: "Mozilla/5.0",
        deviceType: "desktop" as const,
        enteredToken: 0,
        tokenEntered: null,
        wasConnectedTo: 0,
        hostToken: null,
        hadFileTransfer: 0,
        bytesTransferred: 0,
        sessionDurationSeconds: 0,
        sessionId: "test-session-123",
      };

      // Should not throw
      await expect(recordPageView(pageViewData)).resolves.toBeUndefined();
    });

    it("should record a page view with token entry", async () => {
      const pageViewData = {
        visitedAt: new Date(),
        ipAddress: "192.168.1.101",
        referrer: null,
        userAgent: "Mozilla/5.0",
        deviceType: "mobile" as const,
        enteredToken: 1,
        tokenEntered: "1234",
        wasConnectedTo: 0,
        hostToken: null,
        hadFileTransfer: 0,
        bytesTransferred: 0,
        sessionDurationSeconds: 0,
        sessionId: "test-session-456",
      };

      await expect(recordPageView(pageViewData)).resolves.toBeUndefined();
    });

    it("should record a page view with host connection", async () => {
      const pageViewData = {
        visitedAt: new Date(),
        ipAddress: "192.168.1.102",
        referrer: null,
        userAgent: "Mozilla/5.0",
        deviceType: "tablet" as const,
        enteredToken: 0,
        tokenEntered: null,
        wasConnectedTo: 1,
        hostToken: "5678",
        hadFileTransfer: 0,
        bytesTransferred: 0,
        sessionDurationSeconds: 0,
        sessionId: "test-session-789",
      };

      await expect(recordPageView(pageViewData)).resolves.toBeUndefined();
    });
  });

  describe("getPageViewStats", () => {
    it("should return page view stats for a time range", async () => {
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const endTime = new Date();

      const stats = await getPageViewStats(startTime, endTime);

      // Should return an array (could be empty if no data)
      expect(Array.isArray(stats)).toBe(true);
    });

    it("should handle empty time range gracefully", async () => {
      const startTime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30); // 30 days ago
      const endTime = new Date(Date.now() - 1000 * 60 * 60 * 24 * 29); // 29 days ago

      const stats = await getPageViewStats(startTime, endTime);

      // Should return an array
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe("getPageViewsByDeviceType", () => {
    it("should return device type statistics", async () => {
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endTime = new Date();

      const stats = await getPageViewsByDeviceType(startTime, endTime);

      // Should return an array
      expect(Array.isArray(stats)).toBe(true);

      // If there are results, they should have deviceType and count
      if (stats && stats.length > 0) {
        stats.forEach((stat) => {
          expect(stat).toHaveProperty("deviceType");
          expect(stat).toHaveProperty("count");
          expect(["desktop", "tablet", "mobile"]).toContain(stat.deviceType);
        });
      }
    });

    it("should aggregate counts by device type", async () => {
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const endTime = new Date();

      const stats = await getPageViewsByDeviceType(startTime, endTime);

      // Should return an array
      expect(Array.isArray(stats)).toBe(true);

      // Each device type should appear at most once
      if (stats && stats.length > 0) {
        const deviceTypes = stats.map((s) => s.deviceType);
        const uniqueDeviceTypes = new Set(deviceTypes);
        expect(uniqueDeviceTypes.size).toBe(deviceTypes.length);
      }
    });
  });
});
