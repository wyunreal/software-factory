FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @opencode/cli@2.3.2 \
  && git config --system --add safe.directory '*'

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build \
  && mkdir -p /data \
  && chmod +x /app/docker/opencode-entrypoint.sh \
  && ln -sf /app/docker/opencode-entrypoint.sh /usr/local/bin/opencode-entrypoint.sh

# Bake the isolated OpenCode configuration and agent profiles into the image.
# Docker Compose shadows these paths with read-only bind mounts; Kubernetes
# uses them directly, so the runtime does not depend on host-mounted files.
RUN mkdir -p /config/opencode/agents \
  && cp /app/opencode/opencode.json /config/opencode/opencode.json \
  && cp /app/squads/software-development/agents/*.md /config/opencode/agents/

EXPOSE 3000 8080

CMD ["node", "dist/src/index.js"]
