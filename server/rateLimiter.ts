/**
 * Simple in-memory rate limiter for IP addresses
 * Tracks last request time for each IP
 */

interface RateLimitEntry {
  lastRequestTime: number;
  count: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// IP blacklist - these IPs are completely blocked
const ipBlacklist = new Set<string>([
  "103.101.221.72", // Blocked due to high-frequency spam
]);

/**
 * Check if an IP should be rate limited
 * Returns true if the request should be allowed, false if it should be blocked
 */
export function checkRateLimit(
  ipAddress: string,
  limitPerMinute: number = 1
): boolean {
  // Check if IP is blacklisted
  if (ipBlacklist.has(ipAddress)) {
    console.warn(`[IPBlacklist] IP ${ipAddress} is blacklisted and blocked`);
    return false;
  }

  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;

  const entry = rateLimitMap.get(ipAddress);

  // If no entry exists, allow the request
  if (!entry) {
    rateLimitMap.set(ipAddress, {
      lastRequestTime: now,
      count: 1,
    });
    return true;
  }

  // If last request was more than a minute ago, reset counter
  if (entry.lastRequestTime < oneMinuteAgo) {
    rateLimitMap.set(ipAddress, {
      lastRequestTime: now,
      count: 1,
    });
    return true;
  }

  // If within the same minute, check if we've exceeded the limit
  if (entry.count < limitPerMinute) {
    entry.count++;
    entry.lastRequestTime = now;
    return true;
  }

  // Rate limit exceeded
  return false;
}

/**
 * Get rate limit stats for debugging
 */
export function getRateLimitStats(ipAddress: string) {
  return rateLimitMap.get(ipAddress);
}

/**
 * Clear rate limit for an IP (for testing/admin purposes)
 */
export function clearRateLimit(ipAddress: string) {
  rateLimitMap.delete(ipAddress);
}

/**
 * Clear all rate limits
 */
export function clearAllRateLimits() {
  rateLimitMap.clear();
}
