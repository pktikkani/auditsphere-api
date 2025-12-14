import { createTRPCRouter, protectedProcedure } from '../init.js';

export const userRouter = createTRPCRouter({
  /**
   * Get current user info
   */
  me: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.user) {
      return null;
    }

    return {
      id: ctx.user.id,
      email: ctx.user.email,
      name: ctx.user.name,
      role: ctx.user.role,
      hasMicrosoftConnection: (ctx.user.microsoftConnections?.length || 0) > 0,
    };
  }),
});
