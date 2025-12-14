FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source code (cache bust on every change)
COPY . .

# Build (includes tsc-alias to resolve path aliases)
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Regenerate prisma client for production
RUN npx prisma generate

# Expose port
EXPOSE 3000

# Start
CMD ["node", "dist/src/server.js"]
