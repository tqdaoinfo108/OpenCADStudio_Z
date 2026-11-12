# Production Dockerfile for Nếp Nhà 3D Architectural Web Viewer
FROM node:24-alpine

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@11.23.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* .npmrc* ./

# Install production and dev dependencies for build
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build frontend production bundle
RUN pnpm build

# Ensure data directory exists for SQLite
RUN mkdir -p /app/data

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_DRIVER=sqlite

EXPOSE 3000

CMD ["node", "server/index.js"]
