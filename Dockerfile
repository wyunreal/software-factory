FROM oven/bun:1.3.14-debian

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
  && bun add -g --trust @opencode/cli@2.3.2 \
  && git config --system --add safe.directory '*'

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN mkdir -p /data \
  && chmod +x /app/docker/opencode-entrypoint.sh \
  && ln -sf /app/docker/opencode-entrypoint.sh /usr/local/bin/opencode-entrypoint.sh

EXPOSE 3000 8080

CMD ["bun", "run", "src/index.ts"]
