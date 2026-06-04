# appwrite-console-mcp

MCP-сервер с рут-доступом ко всем проектам Appwrite. Логинится рут-аккаунтом в
контексте `console`, а для данных конкретного проекта на лету выпускает ключ со
всеми скоупами. Один эндпоинт = весь инстанс + управление проектами.

## Инструменты
- `appwrite_request` — универсальный вызов: `target` (`console` или ID проекта),
  `method`, `path` (без `/v1`), опционально `query` / `body`.
- `list_projects`, `list_organizations`, `create_project`, `delete_project`.

## Переменные окружения
- `APPWRITE_ENDPOINT` — напр. `https://appwrite.example.com/v1`
- `APPWRITE_EMAIL`, `APPWRITE_PASSWORD` — рут-аккаунт (MFA выключен)
- `MCP_SECRET` — токен в пути HTTP-эндпоинта (авторизация коннектора)
- `PORT` — по умолчанию 8000

## Запуск (Docker / Coolify)
Деплой из репозитория как Dockerfile. Контейнер поднимает MCP по stdio и отдаёт
его как Streamable HTTP через supergateway. Коннектор Claude.ai:
`https://<домен>/<MCP_SECRET>/mcp`.

Локально (stdio, без моста):

    APPWRITE_ENDPOINT=... APPWRITE_EMAIL=... APPWRITE_PASSWORD=... node index.mjs
