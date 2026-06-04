import * as Appwrite from "node-appwrite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const { Client } = Appwrite;

const ENDPOINT = process.env.APPWRITE_ENDPOINT;
const EMAIL = process.env.APPWRITE_EMAIL;
const PASSWORD = process.env.APPWRITE_PASSWORD;

if (!ENDPOINT || !EMAIL || !PASSWORD) {
  console.error("Требуются переменные окружения: APPWRITE_ENDPOINT, APPWRITE_EMAIL, APPWRITE_PASSWORD");
  process.exit(1);
}

// Полный набор скоупов. Если сервер вернёт invalid-scopes — список докрутится из текста ошибки.
const FALLBACK_SCOPES = [
  "sessions.write", "users.read", "users.write", "teams.read", "teams.write",
  "databases.read", "databases.write", "collections.read", "collections.write",
  "attributes.read", "attributes.write", "indexes.read", "indexes.write",
  "documents.read", "documents.write", "tables.read", "tables.write",
  "columns.read", "columns.write", "rows.read", "rows.write",
  "files.read", "files.write", "buckets.read", "buckets.write",
  "functions.read", "functions.write", "execution.read", "execution.write",
  "sites.read", "sites.write", "locale.read", "avatars.read", "health.read",
  "providers.read", "providers.write", "messages.read", "messages.write",
  "topics.read", "topics.write", "subscribers.read", "subscribers.write",
  "targets.read", "targets.write", "migrations.read", "migrations.write",
  "vcs.read", "vcs.write", "keys.read", "keys.write",
  "webhooks.read", "webhooks.write", "platforms.read", "platforms.write",
  "rules.read", "rules.write", "tokens.read", "tokens.write", "assistant.read"
];
const ALL_SCOPES = (() => {
  const fromSdk = Appwrite.Scopes
    ? [...new Set(Object.values(Appwrite.Scopes).filter((v) => typeof v === "string"))]
    : [];
  return fromSdk.length ? fromSdk : FALLBACK_SCOPES;
})();

const JSON_HEADERS = { "content-type": "application/json" };

let sessionSecret = null;
let allowedScopes = null;
const keyCache = new Map(); // projectId -> секрет админ-ключа
const consoleClient = new Client().setEndpoint(ENDPOINT).setProject("console");

function cleanPath(p) {
  let s = String(p || "").trim();
  if (!s.startsWith("/")) s = "/" + s;
  if (s.startsWith("/v1/")) s = s.slice(3);
  else if (s === "/v1") s = "/";
  return s;
}
function paramsFor(method, query, body) {
  const m = String(method).toUpperCase();
  return m === "GET" || m === "HEAD" ? query || {} : body || {};
}

async function login() {
  const c = new Client().setEndpoint(ENDPOINT).setProject("console");
  const res = await c.call("POST", "/account/sessions/email", JSON_HEADERS, {
    email: EMAIL,
    password: PASSWORD,
  });
  sessionSecret = res && res.secret;
  if (!sessionSecret) {
    throw new Error("Логин не вернул secret сессии (включён MFA? ограничение платформы на console?)");
  }
  consoleClient.setSession(sessionSecret);
}
async function ensureSession() {
  if (!sessionSecret) await login();
}

// Запрос в контексте console (рут-сессия + admin mode), с переавторизацией при 401.
async function consoleCall(method, path, query, body) {
  await ensureSession();
  const headers = () => ({
    ...JSON_HEADERS,
    "x-appwrite-mode": "admin",
    cookie: `a_session_console=${sessionSecret}`,
  });
  const run = () =>
    consoleClient.call(String(method).toUpperCase(), cleanPath(path), headers(), paramsFor(method, query, body));
  try {
    return await run();
  } catch (e) {
    if (e && e.code === 401) {
      await login();
      return await run();
    }
    throw e;
  }
}

// Гарантирует свежий админ-ключ (все скоупы) для проекта, кэширует секрет.
async function ensureKey(projectId) {
  if (keyCache.has(projectId)) return keyCache.get(projectId);
  // подчистить прежние ключи mcp-admin (секрет старого получить нельзя)
  try {
    const existing = await consoleCall("GET", `/projects/${projectId}/keys`);
    for (const k of (existing && existing.keys) || []) {
      if (k.name === "mcp-admin") {
        try {
          await consoleCall("DELETE", `/projects/${projectId}/keys/${k.$id}`);
        } catch {}
      }
    }
  } catch {}

  const mint = (scopes) =>
    consoleCall("POST", `/projects/${projectId}/keys`, null, { name: "mcp-admin", scopes, expire: null });

  let created;
  try {
    created = await mint(allowedScopes || ALL_SCOPES);
  } catch (e) {
    const m = String((e && e.message) || "").match(/one of \(([^)]+)\)/i);
    if (!m) throw e;
    allowedScopes = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    created = await mint(allowedScopes);
  }
  keyCache.set(projectId, created.secret);
  return created.secret;
}

// Универсальный вызов: target='console' либо ID проекта.
async function apiRequest({ target, method, path, query, body }) {
  if (!target) throw new Error("target обязателен: 'console' или ID проекта");
  if (!path) throw new Error("path обязателен, напр. '/databases'");
  if (target === "console") return await consoleCall(method, path, query, body);
  const key = await ensureKey(target);
  const c = new Client().setEndpoint(ENDPOINT).setProject(target).setKey(key);
  return await c.call(String(method).toUpperCase(), cleanPath(path), JSON_HEADERS, paramsFor(method, query, body));
}

function genId() {
  return ("m" + Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/[^a-z0-9]/g, "").slice(0, 32);
}

const tools = [
  {
    name: "appwrite_request",
    description:
      "Универсальный запрос к Appwrite API с рут-доступом. target='console' — управление инстансом (проекты, организации, ключи, платформы, вебхуки). target=ID проекта — работа с его данными: databases/tablesdb, users, storage, functions, messaging, teams, sites и т.д. Для проектов админ-ключ со всеми скоупами выпускается автоматически. path указывается без префикса /v1, напр. '/databases' или '/databases/{databaseId}/collections'. ВНИМАНИЕ: метод DELETE необратим.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "'console' или ID проекта" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "Путь API без /v1, напр. /users или /databases/{id}/collections/{cid}/documents" },
        query: {
          type: "object",
          description: "Query-параметры для GET, напр. {\"queries\":[\"limit(25)\"],\"search\":\"foo\"}",
          additionalProperties: true,
        },
        body: { type: "object", description: "Тело для POST/PUT/PATCH/DELETE", additionalProperties: true },
      },
      required: ["target", "method", "path"],
    },
  },
  {
    name: "list_projects",
    description: "Список всех проектов инстанса (рут/console).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_organizations",
    description: "Список организаций. teamId оттуда нужен для create_project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_project",
    description: "Создать новый проект в инстансе.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        teamId: { type: "string", description: "ID организации (см. list_organizations)" },
        projectId: { type: "string", description: "Опционально; если пусто — сгенерируется" },
        region: { type: "string", description: "Опционально, для self-hosted обычно 'default'" },
      },
      required: ["name", "teamId"],
    },
  },
  {
    name: "delete_project",
    description: "Безвозвратно удалить проект. Требует confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        confirm: { type: "boolean", description: "Должно быть true" },
      },
      required: ["projectId", "confirm"],
    },
  },
];

function ok(data) {
  let text;
  try {
    text = typeof data === "string" ? data : JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch {
    text = String(data);
  }
  if (text.length > 60000) text = text.slice(0, 60000) + "\n…(обрезано)";
  return { content: [{ type: "text", text }] };
}
function fail(e) {
  const parts = [];
  if (e && e.code) parts.push(`code=${e.code}`);
  if (e && e.type) parts.push(`type=${e.type}`);
  if (e && e.cause && (e.cause.code || e.cause.message)) parts.push(`cause=${e.cause.code || e.cause.message}`);
  let msg = (e && e.message) || String(e);
  if (e && e.response) {
    try {
      msg += " | response: " + (typeof e.response === "string" ? e.response : JSON.stringify(e.response));
    } catch {}
  }
  return { content: [{ type: "text", text: `Ошибка: ${msg}${parts.length ? " (" + parts.join(", ") + ")" : ""}` }], isError: true };
}

const server = new Server({ name: "appwrite-console-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  try {
    switch (name) {
      case "appwrite_request":
        return ok(await apiRequest(args));
      case "list_projects": {
        const r = await consoleCall("GET", "/projects", { queries: ["limit(500)"] });
        const list = (r.projects || []).map((p) => ({ id: p.$id, name: p.name, teamId: p.teamId, region: p.region }));
        return ok({ total: r.total, projects: list });
      }
      case "list_organizations": {
        const r = await consoleCall("GET", "/organizations", { queries: ["limit(500)"] });
        const arr = r.teams || r.organizations || [];
        return ok({ total: r.total, organizations: arr.map((t) => ({ id: t.$id, name: t.name })) });
      }
      case "create_project": {
        const body = { projectId: args.projectId || genId(), name: args.name, teamId: args.teamId };
        if (args.region) body.region = args.region;
        return ok(await consoleCall("POST", "/projects", null, body));
      }
      case "delete_project": {
        if (args.confirm !== true) return fail(new Error("Нужен confirm=true"));
        await consoleCall("DELETE", `/projects/${args.projectId}`);
        return ok({ deleted: args.projectId });
      }
      default:
        return fail(new Error(`Неизвестный инструмент: ${name}`));
    }
  } catch (e) {
    console.error("TOOL ERROR:", (e && (e.stack || e.message)) || e, e && e.cause ? "| cause=" + (e.cause.code || e.cause.message || e.cause) : "");
    return fail(e);
  }
});

await server.connect(new StdioServerTransport());
console.error("appwrite-console-mcp запущен (stdio). ENDPOINT=" + ENDPOINT);

// Стартовая проверка доступности Appwrite из контейнера (видно в логах Coolify).
fetch(ENDPOINT.replace(/\/$/, "") + "/health/version", { headers: { "X-Appwrite-Project": "console" } })
  .then((r) => r.text().then((t) => console.error("STARTUP appwrite:", r.status, t.slice(0, 200))))
  .catch((e) => console.error("STARTUP appwrite ERR:", e && e.message, e && e.cause ? (e.cause.code || e.cause.message) : ""));
