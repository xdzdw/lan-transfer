import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { recordPageView, getPageViewStats, getPageViewsByDeviceType } from "./db";
import { z } from "zod";
import { TRPCError } from "@trpc/server";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  analytics: router({
    /**
     * Record a page view with tracking information
     * Called from the frontend on page load
     */
    recordPageView: publicProcedure
      .input(
        z.object({
          sessionId: z.string(),
          referrer: z.string().optional(),
          userAgent: z.string(),
          deviceType: z.enum(["desktop", "tablet", "mobile"]),
          enteredToken: z.boolean().default(false),
          tokenEntered: z.string().optional(),
          wasConnectedTo: z.boolean().default(false),
          hostToken: z.string().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        // Extract IP from request
        const ipAddress =
          (ctx.req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
          ctx.req.socket.remoteAddress ||
          "unknown";

        await recordPageView({
          visitedAt: new Date(),
          ipAddress,
          referrer: input.referrer || null,
          userAgent: input.userAgent,
          deviceType: input.deviceType,
          enteredToken: input.enteredToken ? 1 : 0,
          tokenEntered: input.tokenEntered || null,
          wasConnectedTo: input.wasConnectedTo ? 1 : 0,
          hostToken: input.hostToken || null,
          hadFileTransfer: 0, // Will be updated later
          bytesTransferred: 0,
          sessionDurationSeconds: 0,
          sessionId: input.sessionId,
        });

        return { success: true };
      }),

    /**
     * Get page view statistics for a time range
     * Admin only
     */
    getStats: protectedProcedure
      .input(
        z.object({
          startTime: z.date(),
          endTime: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only admins can access analytics",
          });
        }
        const stats = await getPageViewStats(input.startTime, input.endTime);
        return stats || [];
      }),

    /**
     * Get page view count by device type
     * Admin only
     */
    getDeviceStats: protectedProcedure
      .input(
        z.object({
          startTime: z.date(),
          endTime: z.date(),
        })
      )
      .query(async ({ input, ctx }) => {
        if (ctx.user?.role !== "admin") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only admins can access analytics",
          });
        }
        const stats = await getPageViewsByDeviceType(
          input.startTime,
          input.endTime
        );
        return stats || [];
      }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
