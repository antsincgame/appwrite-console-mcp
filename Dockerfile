FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm install -g supergateway --no-audit --no-fund
COPY index.mjs ./

ENV PORT=8000
EXPOSE 8000

# stdio MCP -> Streamable HTTP (stateless: child поднимается на каждый запрос — надёжнее).
# Секрет в пути = авторизация для коннектора Claude.ai.
CMD supergateway \
    --stdio "node /app/index.mjs" \
    --outputTransport streamableHttp \
    --port ${PORT} \
    --streamableHttpPath "/${MCP_SECRET}/mcp" \
    --logLevel info
