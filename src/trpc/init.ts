import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { db } from '../lib/db/prisma.js';

// Azure AD JWKS client for token validation
const jwksClientInstance = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
});

/**
 * Get signing key from Azure AD JWKS
 */
async function getSigningKey(kid: string): Promise<string> {
  const key = await jwksClientInstance.getSigningKey(kid);
  return key.getPublicKey();
}

/**
 * Validate Azure AD token and extract user info
 */
async function validateAzureAdToken(token: string): Promise<{ id: string; email: string } | null> {
  try {
    // Decode token header to get kid
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header.kid) {
      return null;
    }

    // Get signing key
    const signingKey = await getSigningKey(decoded.header.kid);

    // Verify token signature only, check claims manually
    const verified = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
    }) as jwt.JwtPayload;

    // Log token claims for debugging
    console.log('[Azure AD] Token claims:', {
      aud: verified.aud,
      iss: verified.iss,
      preferred_username: verified.preferred_username,
      email: verified.email,
      upn: verified.upn,
      oid: verified.oid,
      sub: verified.sub,
    });

    // Validate audience manually (can be client ID or Application ID URI)
    const validAudiences = [
      process.env.MICROSOFT_CLIENT_ID,
      `api://${process.env.MICROSOFT_CLIENT_ID}`,
    ];
    if (!validAudiences.includes(verified.aud as string)) {
      console.error('[Azure AD] Invalid audience:', verified.aud, 'Expected one of:', validAudiences);
      return null;
    }

    // Validate issuer manually (v1 or v2 endpoint)
    const validIssuers = [
      `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/v2.0`,
      `https://sts.windows.net/${process.env.MICROSOFT_TENANT_ID}/`,
    ];
    if (!validIssuers.includes(verified.iss as string)) {
      console.error('[Azure AD] Invalid issuer:', verified.iss, 'Expected one of:', validIssuers);
      return null;
    }

    // Extract user info
    const email = verified.preferred_username || verified.email || verified.upn;
    const id = verified.oid || verified.sub;

    if (!email || !id) {
      console.error('[Azure AD] Token missing email or id');
      return null;
    }

    return { id, email };
  } catch (error) {
    console.error('[Azure AD] Token validation failed:', error);
    return null;
  }
}

/**
 * tRPC Context
 * Contains user information for all procedures
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
  // Check for Azure AD token in Authorization header
  const authHeader = opts.headers.get('Authorization');
  let azureAdUser: { id: string; email: string } | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    azureAdUser = await validateAzureAdToken(token);
  }

  return {
    azureAdUser,
    headers: opts.headers,
  };
};

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

/**
 * Initialize tRPC
 */
const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof Error
            ? error.cause.message
            : null,
      },
    };
  },
});

/**
 * Router and procedure helpers
 */
export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * Public procedure - no authentication required
 */
export const publicProcedure = t.procedure;

/**
 * Protected procedure - requires Azure AD authentication
 */
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  // Check Azure AD token
  const azureAdUser = ctx.azureAdUser as { id: string; email: string } | null;
  if (azureAdUser?.email) {
    console.log('[Azure AD] Looking up user:', azureAdUser.email);

    // Find user based on Azure AD identity (check email field)
    let dbUser = await db.user.findFirst({
      where: { email: azureAdUser.email },
      include: {
        microsoftConnections: {
          where: { isActive: true },
          take: 1,
        },
      },
    });

    // If not found, auto-create the user on first login
    if (!dbUser) {
      console.log('[Azure AD] User not found, creating new user:', azureAdUser.email);
      dbUser = await db.user.create({
        data: {
          auth0Id: azureAdUser.id, // Use Azure AD oid as auth0Id
          email: azureAdUser.email,
          name: azureAdUser.email.split('@')[0], // Use email prefix as name
          role: 'viewer', // Default role
        },
        include: {
          microsoftConnections: {
            where: { isActive: true },
            take: 1,
          },
        },
      });
      console.log('[Azure AD] New user created:', dbUser.id);
    }

    if (dbUser) {
      console.log('[Azure AD] User found:', dbUser.id, '- proceeding to query');
      try {
        const result = await next({
          ctx: {
            ...ctx,
            user: dbUser,
          },
        });
        console.log('[Azure AD] Query completed successfully');
        return result;
      } catch (error) {
        console.error('[Azure AD] Query failed:', error);
        throw error;
      }
    } else {
      console.log('[Azure AD] No user found for:', azureAdUser.email);
    }
  }

  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'You must be authenticated to access this resource',
  });
});

/**
 * Middleware for logging
 */
export const loggerMiddleware = t.middleware(async ({ path, type, next }) => {
  const start = Date.now();
  const result = await next();
  const duration = Date.now() - start;
  console.log(`[tRPC] ${type} ${path} - ${duration}ms`);
  return result;
});

export const loggedProcedure = publicProcedure.use(loggerMiddleware);
