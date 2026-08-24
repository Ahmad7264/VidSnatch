FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       curl \
       ca-certificates \
       unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Install standalone yt-dlp
RUN mkdir -p /app/bin \
    && curl -L \
       https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /app/bin/yt-dlp \
    && chmod +x /app/bin/yt-dlp

# Install bgutil yt-dlp plugin
RUN mkdir -p /app/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider \
    && curl -L \
       https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/bgutil-ytdlp-pot-provider.zip \
       -o /tmp/bgutil.zip \
    && unzip -q /tmp/bgutil.zip \
       -d /app/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider \
    && rm /tmp/bgutil.zip

# Install and compile bgutil HTTP provider
RUN curl -L \
       https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/1.3.1.tar.gz \
       -o /tmp/bgutil-provider.tar.gz \
    && tar -xzf /tmp/bgutil-provider.tar.gz -C /tmp \
    && mv /tmp/bgutil-ytdlp-pot-provider-1.3.1/server /opt/bgutil-server \
    && cd /opt/bgutil-server \
    && npm ci \
    && npx tsc \
    && rm -rf /tmp/bgutil-provider.tar.gz /tmp/bgutil-ytdlp-pot-provider-1.3.1

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Start bgutil provider + VidSnatch
CMD ["sh", "-c", "node /opt/bgutil-server/build/main.js & exec npm start"]