# Tessera: one long-running Node server with an embedded database on a persistent disk.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV HOST=0.0.0.0 \
    PORT=4242 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4242
CMD ["node", "--import", "tsx", "src/server.ts"]
