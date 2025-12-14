import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../init.js';
import { db } from '../../lib/db/prisma.js';
import { TRPCError } from '@trpc/server';
import crypto from 'crypto';

// Simple encryption helpers using Node.js crypto
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  // Use SHA-256 to derive a 32-byte key
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Combine iv + authTag + encrypted data
  return iv.toString('hex') + authTag.toString('hex') + encrypted;
}

function decrypt(encryptedText: string): string {
  const key = getEncryptionKey();

  // Extract iv, authTag, and encrypted data
  const iv = Buffer.from(encryptedText.slice(0, IV_LENGTH * 2), 'hex');
  const authTag = Buffer.from(encryptedText.slice(IV_LENGTH * 2, IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2), 'hex');
  const encrypted = encryptedText.slice(IV_LENGTH * 2 + AUTH_TAG_LENGTH * 2);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

// Helper to mask sensitive strings
function maskString(str: string): string {
  if (str.length <= 8) {
    return '••••••••';
  }
  return str.slice(0, 4) + '••••••••' + str.slice(-4);
}

export const settingsRouter = createTRPCRouter({
  /**
   * Get current credentials status (masked)
   */
  getCredentials: protectedProcedure.query(async ({ ctx }) => {
    const user = ctx.user;

    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    }

    const appCredentials = await db.appCredentials.findUnique({
      where: { userId: user.id },
    });

    // Check if using environment variables
    const envConfigured = !!(
      process.env.MICROSOFT_TENANT_ID &&
      process.env.MICROSOFT_CLIENT_ID &&
      process.env.MICROSOFT_CLIENT_SECRET
    );

    if (!appCredentials) {
      return {
        hasCustomCredentials: false,
        useCustomCredentials: false,
        envConfigured,
        credentials: null,
      };
    }

    // Return masked credentials
    const decryptedTenantId = decrypt(appCredentials.tenantId);
    const decryptedClientId = decrypt(appCredentials.clientId);

    return {
      hasCustomCredentials: true,
      useCustomCredentials: appCredentials.useCustomCredentials,
      envConfigured,
      credentials: {
        tenantId: maskString(decryptedTenantId),
        clientId: maskString(decryptedClientId),
        clientSecret: '••••••••••••••••',
        updatedAt: appCredentials.updatedAt,
      },
    };
  }),

  /**
   * Save or update credentials
   */
  saveCredentials: protectedProcedure
    .input(
      z.object({
        tenantId: z.string().min(1, 'Tenant ID is required'),
        clientId: z.string().min(1, 'Client ID is required'),
        clientSecret: z.string().min(1, 'Client Secret is required'),
        useCustomCredentials: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user;

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      // Encrypt the credentials
      const encryptedTenantId = encrypt(input.tenantId);
      const encryptedClientId = encrypt(input.clientId);
      const encryptedClientSecret = encrypt(input.clientSecret);

      // Upsert credentials
      await db.appCredentials.upsert({
        where: { userId: user.id },
        update: {
          tenantId: encryptedTenantId,
          clientId: encryptedClientId,
          clientSecret: encryptedClientSecret,
          useCustomCredentials: input.useCustomCredentials,
        },
        create: {
          userId: user.id,
          tenantId: encryptedTenantId,
          clientId: encryptedClientId,
          clientSecret: encryptedClientSecret,
          useCustomCredentials: input.useCustomCredentials,
        },
      });

      return {
        success: true,
        message: 'Credentials saved successfully',
      };
    }),

  /**
   * Delete custom credentials
   */
  deleteCredentials: protectedProcedure.mutation(async ({ ctx }) => {
    const user = ctx.user;

    if (!user) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
    }

    await db.appCredentials.deleteMany({
      where: { userId: user.id },
    });

    return {
      success: true,
      message: 'Credentials removed',
    };
  }),

  /**
   * Toggle use of custom credentials
   */
  toggleCustomCredentials: protectedProcedure
    .input(z.object({ useCustomCredentials: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const user = ctx.user;

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const existing = await db.appCredentials.findUnique({
        where: { userId: user.id },
      });

      if (!existing) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No custom credentials configured',
        });
      }

      await db.appCredentials.update({
        where: { userId: user.id },
        data: { useCustomCredentials: input.useCustomCredentials },
      });

      return {
        success: true,
        useCustomCredentials: input.useCustomCredentials,
      };
    }),
});
