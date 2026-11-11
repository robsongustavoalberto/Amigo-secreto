const NAMES = ["Cidia", "Dinalva", "Domingas", "Lurdes", "Luisa", "Nilza", "Olivia", "Osoria"];

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
}
function b64ToBytes(value) {
  const bin = atob(value);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function bytesToB64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return b64ToBytes(padded);
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function makeToken(payload, secret) {
  const part = bytesToB64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(part));
  return part + "." + bytesToB64Url(new Uint8Array(sig));
}
async function readToken(token, secret) {
  const [part, sig, extra] = String(token || "").split(".");
  if (!part || !sig || extra) return null;
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64UrlToBytes(sig), new TextEncoder().encode(part));
  if (!valid) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64UrlToBytes(part))); } catch (_) { return null; }
  if (!data || !NAMES.includes(data.me) || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}
async function decryptParticipant(entry, password) {
  try {
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64ToBytes(entry.s), iterations: 200000, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(entry.i) }, key, b64ToBytes(entry.c));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (_) { return null; }
}
function hasPerfectMatching(people, recipients) {
  if (people.length !== recipients.length) return false;
  const ordered = [...people].sort((a, b) => recipients.filter(x => x !== a).length - recipients.filter(x => x !== b).length);
  function search(index, available) {
    if (index === ordered.length) return true;
    const person = ordered[index];
    for (const recipient of available) {
      if (recipient === person) continue;
      if (search(index + 1, available.filter(x => x !== recipient))) return true;
    }
    return false;
  }
  return search(0, recipients);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin) || origin === "http://localhost:8788";
    if (request.method === "OPTIONS") {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (!allowed) return json({ code: "origin/blocked", error: "Origem não autorizada." }, 403);
    if (request.method !== "POST") return json({ code: "method/not-allowed", error: "Utiliza POST." }, 405, cors(origin));
    if (!env.GAME || !env.TOKEN_SECRET || !env.PARTICIPANTS_ENC) return json({ code: "server/not-configured", error: "O servidor ainda não foi configurado pelo administrador." }, 500, cors(origin));
    const id = env.GAME.idFromName("othekula-game-main");
    const stub = env.GAME.get(id);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set("x-client-ip", request.headers.get("CF-Connecting-IP") || "unknown");
    const forwarded = new Request("https://internal" + url.pathname, { method: "POST", headers, body: await request.text() });
    const response = await stub.fetch(forwarded);
    const outHeaders = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors(origin))) outHeaders.set(k, v);
    return new Response(response.body, { status: response.status, headers: outHeaders });
  }
};

function cors(origin) {
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400" };
}

export class OthekulaGame {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS draws (participant TEXT PRIMARY KEY, recipient TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, phone TEXT NOT NULL, attempted_at INTEGER NOT NULL)");
    this.queue = Promise.resolve();
  }
  fetch(request) {
    // Serializa login e sorteios no mesmo objeto para impedir atribuições concorrentes incompatíveis.
    const run = this.queue.then(() => this.handle(request));
    this.queue = run.catch(() => {});
    return run;
  }
  async handle(request) {
    const path = new URL(request.url).pathname;
    let body = {};
    try { body = await request.json(); } catch (_) { return json({ code: "request/invalid", error: "Pedido inválido." }, 400); }
    if (path === "/login") return this.login(request, body);
    if (path === "/result" || path === "/draw") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
      const user = await readToken(token, this.env.TOKEN_SECRET);
      if (!user) return json({ code: "auth/unauthorized", error: "Sessão inválida ou expirada. Entra novamente." }, 401);
      if (path === "/result") {
        const row = this.sql.exec("SELECT recipient FROM draws WHERE participant = ?", user.me).toArray()[0];
        return json({ to: row ? row.recipient : null });
      }
      return this.draw(user.me);
    }
    return json({ code: "route/not-found", error: "Rota não encontrada." }, 404);
  }
  async login(request, body) {
    const ip = request.headers.get("x-client-ip") || "unknown";
    const now = Math.floor(Date.now() / 1000);
    this.sql.exec("DELETE FROM login_attempts WHERE attempted_at < ?", now - 900);
    let phone = String(body.phone || "").replace(/\D/g, "");
    if (phone.length > 9) phone = phone.slice(-9);
    const count = this.sql.exec("SELECT COUNT(*) AS total FROM login_attempts WHERE ip = ? AND phone = ?", ip, phone).one().total;
    if (count >= 10) return json({ code: "auth/too-many-attempts", error: "Muitas tentativas para este número. Aguarda 15 minutos e tenta novamente." }, 429);
    this.sql.exec("INSERT INTO login_attempts (ip, phone, attempted_at) VALUES (?, ?, ?)", ip, phone, now);
    const pin = String(body.pin || "").trim();
    if (phone.length !== 9 || !/^\d{4}$/.test(pin)) return json({ code: "participant/invalid", error: "Número ou PIN incorreto." }, 401);
    let entries;
    try { entries = JSON.parse(this.env.PARTICIPANTS_ENC); } catch (_) { return json({ code: "server/secret-invalid", error: "Configuração de participantes inválida." }, 500); }
    let participant = null;
    for (const entry of entries) {
      participant = await decryptParticipant(entry, phone + ":" + pin);
      if (participant) break;
    }
    if (!participant || !NAMES.includes(participant.me)) return json({ code: "participant/invalid", error: "Número ou PIN incorreto." }, 401);
    const payload = { me: participant.me, exp: now + 12 * 60 * 60 };
    const token = await makeToken(payload, this.env.TOKEN_SECRET);
    return json({ token, me: participant.me });
  }
  draw(me) {
    const existing = this.sql.exec("SELECT recipient FROM draws WHERE participant = ?", me).toArray()[0];
    if (existing) return json({ to: existing.recipient });
    const rows = this.sql.exec("SELECT participant, recipient FROM draws").toArray();
    const done = new Set(rows.map(r => r.participant));
    const taken = new Set(rows.map(r => r.recipient));
    if (done.has(me)) return json({ code: "draw/inconsistent", error: "O teu registo está incompleto. Contacta o organizador." }, 409);
    const peopleLeft = NAMES.filter(n => !done.has(n) && n !== me);
    const recipientsLeft = NAMES.filter(n => !taken.has(n));
    const candidates = recipientsLeft.filter(recipient => recipient !== me &&
      hasPerfectMatching(peopleLeft, recipientsLeft.filter(n => n !== recipient)));
    if (!candidates.length) return json({ code: "draw/no-options", error: "Não há uma atribuição válida restante. Contacta o organizador." }, 409);
    const bytes = new Uint32Array(1); crypto.getRandomValues(bytes);
    const recipient = candidates[bytes[0] % candidates.length];
    this.sql.exec("INSERT INTO draws (participant, recipient, created_at) VALUES (?, ?, ?)", me, recipient, Date.now());
    return json({ to: recipient });
  }
}
