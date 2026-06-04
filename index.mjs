import * as Appwrite from "node-appwrite";
import { readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
  const fromSdk = Appwrite && Appwrite.Scopes
    ? [...new Set(Object.values(Appwrite.Scopes).filter((v) => typeof v === "string"))]
    : [];
  return fromSdk.length ? fromSdk : FALLBACK_SCOPES;
})();

const BASE = ENDPOINT.replace(/\/$/, ""); // напр. https://appwrite.vibecoding.by/v1
const BASE_HEADERS = { "content-type": "application/json", "x-appwrite-response-format": "1.8.0" };

// Кэш на диске: supergateway в stateless-режиме спавнит новый процесс на каждый запрос,
// поэтому переменные в памяти не живут между вызовами. Храним сессию и ключи проектов в /tmp,
// чтобы НЕ логиниться каждый раз (Appwrite лимитирует логины ~10/час) и переиспользовать ключи.
const CACHE_FILE = process.env.MCP_CACHE_FILE || "/tmp/appwrite-mcp-cache.json";

let sessionSecret = null;
let allowedScopes = null;
const keyCache = new Map(); // projectId -> секрет админ-ключа

function loadCache() {
  try {
    const c = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (c && typeof c === "object") {
      if (c.session) sessionSecret = c.session;
      if (Array.isArray(c.allowedScopes) && c.allowedScopes.length) allowedScopes = c.allowedScopes;
      if (c.keys && typeof c.keys === "object") {
        for (const [k, v] of Object.entries(c.keys)) keyCache.set(k, v);
      }
    }
  } catch {}
}
function saveCache() {
  try {
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ session: sessionSecret, allowedScopes, keys: Object.fromEntries(keyCache) })
    );
  } catch (e) {
    console.error("CACHE write error:", e && e.message);
  }
}
loadCache();

function cleanPath(p) {
  let s = String(p || "").trim();
  if (!s.startsWith("/")) s = "/" + s;
  if (s.startsWith("/v1/")) s = s.slice(3);
  else if (s === "/v1") s = "/";
  return s;
}

// Единый HTTP-слой поверх fetch (без node-appwrite SDK — он нестабилен между версиями).
async function rawCall(method, path, { query, body, headers } = {}) {
  const u = new URL(BASE + cleanPath(path));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k + "[]", String(x)));
      else if (v !== undefined && v !== null) u.searchParams.append(k, String(v));
    }
  }
  const m = String(method).toUpperCase();
  const init = { method: m, headers: { ...BASE_HEADERS, ...(headers || {}) } };
  if (m !== "GET" && m !== "HEAD" && body !== undefined && body !== null) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(u, init);
  const text = await res.text();
  let data = text;
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.message) || ("HTTP " + res.status + " " + String(text).slice(0, 300)));
    err.code = res.status;
    if (data && data.type) err.type = data.type;
    err.response = data;
    throw err;
  }
  return data;
}

// Логин рут-аккаунтом в console. Сессия приходит в Set-Cookie (a_session_console).
async function login() {
  const res = await fetch(BASE + "/account/sessions/email", {
    method: "POST",
    headers: { ...BASE_HEADERS, "x-appwrite-project": "console" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok) {
    throw new Error("Логин не удался: HTTP " + res.status + " " + String(body.message || text).slice(0, 300));
  }
  let secret = body && body.secret;
  if (!secret) {
    const cookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    for (const ck of cookies) {
      const mm = /a_session_console=([^;]+)/.exec(ck);
      if (mm) {
        secret = decodeURIComponent(mm[1]);
        break;
      }
    }
  }
  if (!secret) {
    throw new Error("Логин прошёл (HTTP " + res.status + "), но секрет сессии не найден ни в теле, ни в Set-Cookie");
  }
  sessionSecret = secret;
  saveCache();
}
async function ensureSession() {
  if (!sessionSecret) await login();
}

// Запрос в контексте console (рут-сессия), с переавторизацией при 401.
// ВАЖНО: x-appwrite-mode:admin для проекта console запрещён.
async function consoleCall(method, path, query, body) {
  await ensureSession();
  const headers = () => ({
    "x-appwrite-project": "console",
    "x-appwrite-session": sessionSecret,
    cookie: `a_session_console=${sessionSecret}`,
  });
  try {
    return await rawCall(method, path, { query, body, headers: headers() });
  } catch (e) {
    if (e && e.code === 401) {
      await login(); // сессия протухла — релогин (и пересохранение кэша)
      return await rawCall(method, path, { query, body, headers: headers() });
    }
    throw e;
  }
}

// Запрос к данным конкретного проекта по его API-ключу (лимитам логина не подвержен).
async function projectCall(projectId, method, path, query, body) {
  const doCall = (k) =>
    rawCall(method, path, { query, body, headers: { "x-appwrite-project": projectId, "x-appwrite-key": k } });
  let key = await ensureKey(projectId);
  try {
    return await doCall(key);
  } catch (e) {
    if (e && e.code === 401) {
      // ключ отозван/удалён — выпустить заново и повторить один раз
      keyCache.delete(projectId);
      saveCache();
      key = await ensureKey(projectId);
      return await doCall(key);
    }
    throw e;
  }
}

// Гарантирует админ-ключ (все скоупы) для проекта, кэширует секрет на диск.
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
  saveCache();
  return created.secret;
}

// Универсальный вызов: target='console' либо ID проекта.
async function apiRequest({ target, method, path, query, body }) {
  if (!target) throw new Error("target обязателен: 'console' или ID проекта");
  if (!path) throw new Error("path обязателен, напр. '/databases'");
  if (target === "console") return await consoleCall(method, path, query, body);
  return await projectCall(target, method, path, query, body);
}

function genId() {
  return ("m" + Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/[^a-z0-9]/g, "").slice(0, 32);
}

const tools = [
  {
    name: "appwrite_request",
    description:
      "Универсальный запрос к Appwrite API с рут-доступом. target='console' — управление инстансом (проекты, организации/команды, ключи, платформы, вебхуки). target=ID проекта — работа с его данными: databases/tablesdb, users, storage, functions, messaging, teams, sites и т.д. Для проектов админ-ключ со всеми скоупами выпускается автоматически. path указывается без префикса /v1, напр. '/databases' или '/databases/{databaseId}/collections'. ВНИМАНИЕ: метод DELETE необратим.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "'console' или ID проекта" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "Путь API без /v1, напр. /users или /databases/{id}/collections/{cid}/documents" },
        query: {
          type: "object",
          description: "Query-параметры для GET. queries — массив строк-фильтров в JSON-формате Appwrite, напр. {\"queries\":[\"{\\\"method\\\":\\\"limit\\\",\\\"values\\\":[25]}\"]}. Простые параметры — как есть, напр. {\"search\":\"foo\"}.",
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
    description: "Список организаций/команд console. teamId оттуда нужен для create_project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_project",
    description: "Создать новый проект в инстансе.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        teamId: { type: "string", description: "ID организации/команды (см. list_organizations)" },
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
  if (e && e.response && typeof e.response === "object") {
    try {
      msg += " | response: " + JSON.stringify(e.response).slice(0, 400);
    } catch {}
  }
  return { content: [{ type: "text", text: `Ошибка: ${msg}${parts.length ? " (" + parts.join(", ") + ")" : ""}` }], isError: true };
}

const server = new Server({ name: "appwrite-console-mcp", version: "1.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  try {
    switch (name) {
      case "appwrite_request":
        return ok(await apiRequest(args));
      case "list_projects": {
        const r = await consoleCall("GET", "/projects");
        const list = (r.projects || []).map((p) => ({ id: p.$id, name: p.name, teamId: p.teamId, region: p.region }));
        return ok({ total: r.total, projects: list });
      }
      case "list_organizations": {
        // self-hosted: организации это команды console -> /teams
        const r = await consoleCall("GET", "/teams");
        const arr = r.teams || [];
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
console.error("appwrite-console-mcp запущен (stdio). ENDPOINT=" + ENDPOINT + " cache=" + CACHE_FILE);
