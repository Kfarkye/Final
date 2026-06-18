# Stage 1: Build stage
FROM node:24-slim AS builder
WORKDIR /app

# Install build dependencies required for compiling node-gyp or other native modules, and Deno
RUN apt-get update && apt-get install -y python3 make g++ curl unzip && \
    curl -fsSL https://deno.land/x/install/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Copy package configurations and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the source code and run the build script
COPY . .
RUN npm run build

# Clean devDependencies by running npm prune or a clean production install
RUN rm -rf node_modules && npm ci --only=production

# Stage 2: Production runner stage
FROM node:24-slim AS runner
WORKDIR /app

# Install Deno + headless Chromium + dumb-init (PID 1 zombie reaper) for browser tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl unzip \
    dumb-init \
    chromium \
    fonts-liberation \
    fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxss1 \
    && curl -fsSL https://deno.land/x/install/install.sh | sh \
    && apt-get purge -y --auto-remove curl unzip \
    && rm -rf /var/lib/apt/lists/*
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy package configuration
COPY package*.json ./

# Copy built production files and production node_modules from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/mcp-servers ./mcp-servers
COPY --from=builder /app/config ./config

# Copy compiled MCP servers to the expected location
RUN mkdir -p /opt/truth/mcp-servers && cp -r mcp-servers/* /opt/truth/mcp-servers/

# Configure production environment
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# dumb-init as PID 1: reaps zombie Chromium processes, forwards signals cleanly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npm", "start"]
