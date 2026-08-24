FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       curl \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Make sure bin directory exists and install yt-dlp
RUN mkdir -p /app/bin \
    && curl -L \
       https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /app/bin/yt-dlp \
    && chmod +x /app/bin/yt-dlp

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]