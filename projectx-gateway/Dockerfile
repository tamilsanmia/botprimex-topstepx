FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8787)+'/health').then(r=>r.json()).then(j=>process.exit(j.ready?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
