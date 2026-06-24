/**
 * Analytics Dashboard
 * Display page view statistics and user behavior tracking
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Calendar, BarChart3, AlertCircle } from "lucide-react";
import { format, subDays } from "date-fns";
import { useLocation } from "wouter";

export default function Analytics() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [startDate, setStartDate] = useState(
    format(subDays(new Date(), 7), "yyyy-MM-dd")
  );
  const [endDate, setEndDate] = useState(format(new Date(), "yyyy-MM-dd"));

  // Redirect to home if not admin
  if (!authLoading && (!user || user.role !== "admin")) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600">
              <AlertCircle className="w-5 h-5" />
              Access Denied
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              You do not have permission to access the analytics dashboard. Only administrators can view this page.
            </p>
            <Button
              onClick={() => setLocation("/")}
              className="w-full"
            >
              Back to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin" />
      </div>
    );
  }

  const startTime = new Date(`${startDate}T00:00:00`);
  const endTime = new Date(`${endDate}T23:59:59`);

  const statsQuery = trpc.analytics.getStats.useQuery({
    startTime,
    endTime,
  });

  const deviceStatsQuery = trpc.analytics.getDeviceStats.useQuery({
    startTime,
    endTime,
  });

  const stats = statsQuery.data || [];
  const deviceStats = deviceStatsQuery.data || [];

  // Calculate summary statistics
  const totalPageViews = stats.length;
  const uniqueSessions = new Set(stats.map((s) => s.sessionId)).size;
  const tokenEntries = stats.filter((s) => s.enteredToken === 1).length;
  const hostConnections = stats.filter((s) => s.wasConnectedTo === 1).length;

  // Device type breakdown
  const deviceBreakdown = deviceStats.reduce(
    (acc, stat) => {
      acc[stat.deviceType] = stat.count || 0;
      return acc;
    },
    {} as Record<string, number>
  );

  // Top referrers
  const referrerStats = stats
    .filter((s) => s.referrer)
    .reduce(
      (acc, s) => {
        const ref = s.referrer || "direct";
        acc[ref] = (acc[ref] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

  const topReferrers = Object.entries(referrerStats)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const isLoading = statsQuery.isLoading || deviceStatsQuery.isLoading;
  const hasError = statsQuery.isError || deviceStatsQuery.isError;
  const error = statsQuery.error || deviceStatsQuery.error;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground mb-2">
            Analytics Dashboard
          </h1>
          <p className="text-muted-foreground">
            Page view tracking and user behavior analysis
          </p>
        </div>

        {/* Error State */}
        {hasError && (
          <Card className="mb-6 border-red-200 bg-red-50">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-semibold text-red-900">Error loading analytics</p>
                  <p className="text-sm text-red-800 mt-1">
                    {error?.message || "Failed to load analytics data. Please try again."}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Date Range Selector */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Date Range
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 items-end">
              <div>
                <label className="text-sm font-medium text-foreground">
                  Start Date
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="mt-1 px-3 py-2 border border-input rounded-md bg-background text-foreground"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">
                  End Date
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="mt-1 px-3 py-2 border border-input rounded-md bg-background text-foreground"
                />
              </div>
              <Button
                onClick={() => {
                  statsQuery.refetch();
                  deviceStatsQuery.refetch();
                }}
                disabled={isLoading}
              >
                {isLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Page Views
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {isLoading ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  totalPageViews
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Unique Sessions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {isLoading ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  uniqueSessions
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Token Entries
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {isLoading ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  tokenEntries
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Host Connections
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">
                {isLoading ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : (
                  hostConnections
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Device Breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5" />
                Device Type Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex justify-center">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : (
                <div className="space-y-3">
                  {Object.entries(deviceBreakdown).map(([device, count]) => (
                    <div key={device} className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground capitalize">
                        {device}
                      </span>
                      <div className="flex items-center gap-2">
                        <div className="w-32 bg-muted rounded-full h-2">
                          <div
                            className="bg-primary h-2 rounded-full"
                            style={{
                              width: `${
                                totalPageViews > 0
                                  ? (count / totalPageViews) * 100
                                  : 0
                              }%`,
                            }}
                          />
                        </div>
                        <span className="text-sm font-semibold text-foreground w-12 text-right">
                          {count}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Top Referrers */}
          <Card>
            <CardHeader>
              <CardTitle>Top Referrers</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex justify-center">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : topReferrers.length > 0 ? (
                <div className="space-y-2">
                  {topReferrers.map(([referrer, count]) => (
                    <div
                      key={referrer}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="text-foreground truncate">
                        {referrer.length > 40
                          ? referrer.substring(0, 37) + "..."
                          : referrer}
                      </span>
                      <span className="font-semibold text-primary">{count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No referrer data</p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Raw Data Table */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Page Views</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : stats.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-2 font-semibold text-foreground">
                        Time
                      </th>
                      <th className="text-left py-2 px-2 font-semibold text-foreground">
                        IP Address
                      </th>
                      <th className="text-left py-2 px-2 font-semibold text-foreground">
                        Device
                      </th>
                      <th className="text-left py-2 px-2 font-semibold text-foreground">
                        Token Entry
                      </th>
                      <th className="text-left py-2 px-2 font-semibold text-foreground">
                        Host
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.slice(0, 20).map((view, idx) => (
                      <tr
                        key={idx}
                        className="border-b border-border hover:bg-muted/50"
                      >
                        <td className="py-2 px-2 text-foreground/80">
                          {format(
                            new Date(view.visitedAt),
                            "MMM dd, HH:mm:ss"
                          )}
                        </td>
                        <td className="py-2 px-2 text-foreground/80 font-mono">
                          {view.ipAddress}
                        </td>
                        <td className="py-2 px-2 text-foreground/80 capitalize">
                          {view.deviceType}
                        </td>
                        <td className="py-2 px-2">
                          {view.enteredToken === 1 ? (
                            <span className="inline-block bg-primary/20 text-primary px-2 py-1 rounded text-xs font-semibold">
                              {view.tokenEntered}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2">
                          {view.wasConnectedTo === 1 ? (
                            <span className="inline-block bg-green-500/20 text-green-700 px-2 py-1 rounded text-xs font-semibold">
                              {view.hostToken}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">
                No data available for the selected date range
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
