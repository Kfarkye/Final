FROM node:24
WORKDIR /app

# Install Deno and system dependencies
RUN apt-get update && apt-get install -y curl unzip && \
    curl -fsSL https://deno.land/x/install/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source and build
COPY . .
RUN npm run build

# Copy compiled MCP servers to /opt/truth/mcp-servers
RUN mkdir -p /opt/truth/mcp-servers && cp -r mcp-servers/* /opt/truth/mcp-servers/

# Configure production environment
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Start the compiled Express server
CMD ["npm", "start"]
