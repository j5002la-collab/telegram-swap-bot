# ---- Build Stage ----
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ---- Production Stage ----
FROM node:22-alpine

RUN apk add --no-cache tini

# Create non-root user for security
RUN addgroup -g 1001 swapbot && \
    adduser -u 1001 -G swapbot -s /bin/sh -D swapbot

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Set strict permissions: only swapbot can read the app
RUN chown -R swapbot:swapbot /app && \
    chmod 750 /app

USER swapbot

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
