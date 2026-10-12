FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    RESOLUTION=1440x900x24 \
    DISPLAY=:99

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    ffmpeg \
    libgtk-3-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    fonts-noto-cjk \
    fonts-liberation \
    procps \
    curl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /root/.fluxbox && \
    echo "session.screen0.toolbar.visible: false" > /root/.fluxbox/init && \
    printf '[app] (name=.*)\n  [Maximized] {yes}\n  [Deco] {NONE}\n[end]\n' > /root/.fluxbox/apps

RUN echo '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=vnc.html?autoconnect=true&resize=remote"></head><body><p>Redirecting to <a href="vnc.html?autoconnect=true&resize=remote">Bang Story</a>...</p></body></html>' > /usr/share/novnc/index.html

WORKDIR /app

COPY package*.json ./
COPY electron-builder.yml ./

RUN npm install && node ./node_modules/electron/install.js

COPY . .

RUN npm run build

COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY start-app.sh /app/start-app.sh
RUN chmod +x /app/start-app.sh

EXPOSE 6080

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
