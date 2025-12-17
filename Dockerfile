FROM node:24-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including dev for build)
RUN npm ci

# Copy all source code
COPY . .

# Force rebuild - update this timestamp to bust cache: 2025-12-14T12:50
ARG CACHEBUST=1

# Build (includes tsc-alias to resolve path aliases)
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Regenerate prisma client for production
RUN npx prisma generate

# Expose port
EXPOSE 3000

# Start - run db push to sync schema, then start server
CMD ["sh", "-c", "npx prisma db push && node dist/src/server.js"]
