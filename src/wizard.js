// ═══════════════════════════════════════════════════════════
//  SHΞN™Bypass — Wizard Worker
//  Rebranded panel deployment wizard with collaborative node pool
//  Every user's worker joins the pool; subscription = all active nodes
// ═══════════════════════════════════════════════════════════

import { PANEL_TEMPLATE } from "./panel-template.js";

const BRAND = "SHΞN™Bypass";
const BRAND_SHORT = "shenbypass";
const REMARK = "SHΞN™xray";

// ─── In-memory session store (KV-backed for persistence) ───
const SESSION_TTL = 3600_000; // 1 hour

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // ── CORS ──
    if (method === "OPTIONS") {
      return corsResponse();
    }

    // ── Static assets ──
    if (path === "/" || path === "/index.html") {
      return htmlResponse(landingPage());
    }
    if (path === "/login") {
      return htmlResponse(loginPage());
    }
    if (path === "/panel" || path === "/dashboard") {
      return htmlResponse(dashboardPage());
    }
    if (path === "/style.css") {
      return new Response(css(), {
        headers: { "content-type": "text/css" },
      });
    }

    // ── API Routes ──
    if (path === "/api/register" && method === "POST") {
      return handleRegister(request, env);
    }
    if (path === "/api/login" && method === "POST") {
      return handleLogin(request, env);
    }
    if (path === "/api/deploy" && method === "POST") {
      return handleDeploy(request, env);
    }
    if (path === "/api/heartbeat" && method === "POST") {
      return handleHeartbeat(request, env);
    }
    if (path === "/api/pool" && method === "GET") {
      return handleGetPool(request, env);
    }
    if (path === "/api/sub" && method === "GET") {
      return handleSubscription(request, env);
    }
    if (path === "/api/me" && method === "GET") {
      return handleMe(request, env);
    }
    if (path === "/api/logout" && method === "POST") {
      return handleLogout(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ═══════════════════════════════════════════════════════════
//  AUTH & USER MANAGEMENT
// ═══════════════════════════════════════════════════════════

async function handleRegister(request, env) {
  const { username, password } = await request.json();

  if (!username || !password || password.length < 6) {
    return Response.json(
      { ok: false, error: "Username and password (min 6 chars) required" },
      { status: 400 }
    );
  }

  const userKey = `user:${username}`;
  const existing = await env.POOL.get(userKey);
  if (existing) {
    return Response.json(
      { ok: false, error: "Username already taken" },
      { status: 409 }
    );
  }

  // Generate user ID and panel UUID
  const userId = crypto.randomUUID();
  const panelUuid = crypto.randomUUID();

  const user = {
    userId,
    username,
    passwordHash: await hashPassword(password),
    panelUuid,
    createdAt: Date.now(),
    workerDomain: null,
    deployed: false,
    active: false,
    lastHeartbeat: 0,
  };

  await env.POOL.put(userKey, JSON.stringify(user));
  await env.POOL.put(`userid:${userId}`, userKey);

  // Create session
  const token = crypto.randomUUID();
  await env.POOL.put(
    `session:${token}`,
    JSON.stringify({ userId, username, exp: Date.now() + SESSION_TTL }),
    { expirationTtl: 3600 }
  );

  return Response.json({ ok: true, token, userId, panelUuid });
}

async function handleLogin(request, env) {
  const { username, password } = await request.json();

  const userKey = `user:${username}`;
  const userRaw = await env.POOL.get(userKey);
  if (!userRaw) {
    return Response.json(
      { ok: false, error: "Invalid credentials" },
      { status: 401 }
    );
  }

  const user = JSON.parse(userRaw);
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return Response.json(
      { ok: false, error: "Invalid credentials" },
      { status: 401 }
    );
  }

  const token = crypto.randomUUID();
  await env.POOL.put(
    `session:${token}`,
    JSON.stringify({ userId: user.userId, username, exp: Date.now() + SESSION_TTL }),
    { expirationTtl: 3600 }
  );

  return Response.json({
    ok: true,
    token,
    userId: user.userId,
    panelUuid: user.panelUuid,
    deployed: user.deployed,
  });
}

async function handleLogout(request, env) {
  const token = getToken(request);
  if (token) await env.POOL.delete(`session:${token}`);
  return Response.json({ ok: true });
}

async function getSession(request, env) {
  const token = getToken(request);
  if (!token) return null;
  const raw = await env.POOL.get(`session:${token}`);
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (Date.now() > session.exp) {
    await env.POOL.delete(`session:${token}`);
    return null;
  }
  return session;
}

function getToken(request) {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/shen_token=([^;]+)/);
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════
//  DEPLOY — Deploy panel worker onto user's Cloudflare account
// ═══════════════════════════════════════════════════════════

async function handleDeploy(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return Response.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }

  const { cfToken } = await request.json();
  if (!cfToken) {
    return Response.json({ ok: false, error: "Cloudflare API token required" }, { status: 400 });
  }

  const userKey = `user:${session.username}`;
  const userRaw = await env.POOL.get(userKey);
  if (!userRaw) return Response.json({ ok: false, error: "User not found" }, { status: 404 });
  const user = JSON.parse(userRaw);

  // ── 1. Verify token & get account ID ──
  const verifyRes = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", {
    headers: { Authorization: `Bearer ${cfToken}` },
  });
  const verifyData = await verifyRes.json();
  if (!verifyData.success) {
    return Response.json({ ok: false, error: "Invalid Cloudflare token" }, { status: 401 });
  }

  // Get account ID
  const accountsRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
    headers: { Authorization: `Bearer ${cfToken}` },
  });
  const accountsData = await accountsRes.json();
  if (!accountsData.success || !accountsData.result.length) {
    return Response.json({ ok: false, error: "No accounts found for this token" }, { status: 400 });
  }
  const accountId = accountsData.result[0].id;

  // ── 2. Create KV namespace on user's account ──
  const kvRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfToken}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "shenbypass-panel" }),
  });
  const kvData = await kvRes.json();
  if (!kvData.success) {
    return Response.json({ ok: false, error: "Failed to create KV namespace: " + JSON.stringify(kvData.errors) }, { status: 500 });
  }
  const kvNamespaceId = kvData.result.id;

  // ── 3. Prepare panel worker code ──
  const wizardUrl = `https://${env.WIZARD_DOMAIN || "shenbypass.workers.dev"}`;
  const panelCode = PANEL_TEMPLATE
    .replace("__WIZARD_URL__", wizardUrl)
    .replace("__USER_ID__", user.userId)
    .replace("__PANEL_UUID__", user.panelUuid)
    .replace("__PROXY_IP__", "");

  // ── 4. Deploy worker to user's account ──
  const workerName = "shenbypass-node";
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2024-09-23",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "kv_namespace", name: "PANEL_KV", namespace_id: kvNamespaceId },
    ],
  };

  // Build multipart form
  const boundary = `----SHEN${Date.now()}`;
  const formData = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Disposition: form-data; name="worker.js"; filename="worker.js"',
    "Content-Type: application/javascript+module",
    "",
    panelCode,
    `--${boundary}--`,
  ].join("\r\n");

  const deployRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: formData,
    }
  );
  const deployData = await deployRes.json();

  if (!deployData.success) {
    return Response.json({
      ok: false,
      error: "Failed to deploy worker: " + JSON.stringify(deployData.errors),
    }, { status: 500 });
  }

  // ── 5. Enable workers.dev subdomain ──
  const subdomainRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfToken}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }
  ).catch(() => null);

  // ── 6. Get worker domain ──
  const workerDomain = `${workerName}.${await getWorkersSubdomain(cfToken, accountId)}`;

  // ── 7. Update user record ──
  user.deployed = true;
  user.workerDomain = workerDomain;
  user.accountId = accountId;
  user.kvNamespaceId = kvNamespaceId;
  user.deployedAt = Date.now();

  await env.POOL.put(userKey, JSON.stringify(user));

  // ── 8. Add to pool ──
  await addNodeToPool(env, {
    userId: user.userId,
    workerDomain,
    uuid: user.panelUuid,
    username: user.username,
    addedAt: Date.now(),
    lastHeartbeat: Date.now(),
    active: true,
  });

  return Response.json({
    ok: true,
    workerDomain,
    workerName,
    uuid: user.panelUuid,
    message: "Panel deployed and joined the SHΞN pool!",
  });
}

async function getWorkersSubdomain(token, accountId) {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.success && data.result?.subdomain) {
      return `${data.result.subdomain}.workers.dev`;
    }
  } catch (e) {}
  return "workers.dev";
}

// ═══════════════════════════════════════════════════════════
//  POOL MANAGEMENT
// ═══════════════════════════════════════════════════════════

async function addNodeToPool(env, node) {
  await env.POOL.put(`node:${node.userId}`, JSON.stringify(node));
  // Update pool index
  const indexRaw = await env.POOL.get("pool:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(node.userId)) {
    index.push(node.userId);
    await env.POOL.put("pool:index", JSON.stringify(index));
  }
}

async function handleHeartbeat(request, env) {
  const { userId, workerDomain, uuid, timestamp } = await request.json();

  // Verify this is a legitimate node
  const nodeRaw = await env.POOL.get(`node:${userId}`);
  if (!nodeRaw) {
    // New node registering
    await addNodeToPool(env, {
      userId,
      workerDomain,
      uuid,
      addedAt: timestamp || Date.now(),
      lastHeartbeat: Date.now(),
      active: true,
    });
  } else {
    const node = JSON.parse(nodeRaw);
    node.lastHeartbeat = Date.now();
    node.active = true;
    node.workerDomain = workerDomain || node.workerDomain;
    await env.POOL.put(`node:${userId}`, JSON.stringify(node));
  }

  // Update user record
  const userKeyRaw = await env.POOL.get(`userid:${userId}`);
  if (userKeyRaw) {
    const userRaw = await env.POOL.get(userKeyRaw);
    if (userRaw) {
      const user = JSON.parse(userRaw);
      user.lastHeartbeat = Date.now();
      user.active = true;
      await env.POOL.put(userKeyRaw, JSON.stringify(user));
    }
  }

  return Response.json({ ok: true, poolSize: await getPoolSize(env) });
}

async function getActiveNodes(env) {
  const indexRaw = await env.POOL.get("pool:index");
  if (!indexRaw) return [];
  const index = JSON.parse(indexRaw);
  const nodes = [];
  const now = Date.now();
  const STALE = 120_000; // 2 minutes

  for (const userId of index) {
    const raw = await env.POOL.get(`node:${userId}`);
    if (!raw) continue;
    const node = JSON.parse(raw);
    // Mark stale nodes inactive
    if (now - node.lastHeartbeat > STALE) {
      node.active = false;
    }
    if (node.active) nodes.push(node);
  }
  return nodes;
}

async function getPoolSize(env) {
  const nodes = await getActiveNodes(env);
  return nodes.length;
}

async function handleGetPool(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return Response.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const nodes = await getActiveNodes(env);
  return Response.json({ ok: true, nodes, count: nodes.length });
}

// ═══════════════════════════════════════════════════════════
//  SUBSCRIPTION — Generate sub link with ALL pool nodes
// ═══════════════════════════════════════════════════════════

async function handleSubscription(request, env) {
  const url = new URL(request.url);
  const userId = url.searchParams.get("id") || url.pathname.split("/").pop();

  // Verify user
  const userKeyRaw = await env.POOL.get(`userid:${userId}`);
  if (!userKeyRaw) {
    return new Response("Invalid subscription", { status: 403 });
  }
  const userRaw = await env.POOL.get(userKeyRaw);
  if (!userRaw) return new Response("User not found", { status: 404 });
  const user = JSON.parse(userRaw);

  // Get all active nodes from pool
  const nodes = await getActiveNodes(env);

  if (nodes.length === 0) {
    return new Response("# No active nodes in pool", {
      headers: { "content-type": "text/plain" },
    });
  }

  // Generate configs for each node
  const configs = [];

  for (const node of nodes) {
    const remark = `${REMARK}-${node.username || "node"}-${nodes.indexOf(node) + 1}`;

    // ── VLESS over WS ──
    const wsPath = "/shen-ws";
    const vlessWs = `vless://${node.uuid}@${node.workerDomain}:443?encryption=none&security=tls&sni=${node.workerDomain}&type=ws&host=${node.workerDomain}&path=${encodeURIComponent(wsPath)}#${encodeURIComponent(remark + "-WS")}`;
    configs.push(vlessWs);

    // ── VLESS over gRPC ──
    const grpcService = "shen-grpc";
    const vlessGrpc = `vless://${node.uuid}@${node.workerDomain}:443?encryption=none&security=tls&sni=${node.workerDomain}&type=grpc&serviceName=${grpcService}&mode=gun#${encodeURIComponent(remark + "-gRPC")}`;
    configs.push(vlessGrpc);

    // ── VLESS over XHTTP ──
    const xhttpPath = "/shen-xhttp";
    const vlessXhttp = `vless://${node.uuid}@${node.workerDomain}:443?encryption=none&security=tls&sni=${node.workerDomain}&type=xhttp&host=${node.workerDomain}&path=${encodeURIComponent(xhttpPath)}&mode=auto#${encodeURIComponent(remark + "-XHTTP")}`;
    configs.push(vlessXhttp);

    // ── VLESS Reality (if user's own node) ──
    if (node.userId === userId) {
      const realitySni = "www.cloudflare.com";
      const realityPbk = "0" .repeat(43); // placeholder; reality needs origin TLS
      const vlessReality = `vless://${node.uuid}@${node.workerDomain}:443?encryption=none&security=reality&sni=${realitySni}&pbk=${realityPbk}&fp=chrome&type=tcp&flow=xtls-rprx-vision#${encodeURIComponent(remark + "-Reality")}`;
      // Note: Reality requires direct TCP, not Worker. This is a placeholder.
      configs.push(vlessReality);
    }
  }

  const subContent = configs.join("\n");
  const base64Content = btoa(subContent);

  return new Response(base64Content, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "profile-title": BRAND,
      "profile-update-interval": "6",
      "subscription-userinfo": `upload=0; download=0; total=0; expire=0`,
    },
  });
}

// ═══════════════════════════════════════════════════════════
//  USER INFO
// ═══════════════════════════════════════════════════════════

async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return Response.json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  const userRaw = await env.POOL.get(`user:${session.username}`);
  if (!userRaw) return Response.json({ ok: false, error: "User not found" }, { status: 404 });
  const user = JSON.parse(userRaw);

  const poolSize = await getPoolSize(env);
  const subUrl = `https://${env.WIZARD_DOMAIN || "shenbypass.workers.dev"}/api/sub?id=${user.userId}`;

  return Response.json({
    ok: true,
    user: {
      username: user.username,
      userId: user.userId,
      deployed: user.deployed,
      workerDomain: user.workerDomain,
      panelUuid: user.panelUuid,
    },
    poolSize,
    subscriptionUrl: subUrl,
  });
}

// ═══════════════════════════════════════════════════════════
//  CRYPTO HELPERS
// ═══════════════════════════════════════════════════════════

async function hashPassword(password) {
  const salt = crypto.randomUUID();
  const data = new TextEncoder().encode(salt + password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return salt + ":" + arrayBufferToHex(hash);
}

async function verifyPassword(password, stored) {
  const [salt, hashHex] = stored.split(":");
  const data = new TextEncoder().encode(salt + password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return arrayBufferToHex(hash) === hashHex;
}

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ═══════════════════════════════════════════════════════════
//  RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════

function corsResponse() {
  return new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "*",
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ═══════════════════════════════════════════════════════════
//  HTML PAGES
// ═══════════════════════════════════════════════════════════

function landingPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${BRAND} — Bypass Wizard</title>
<style>${css()}</style>
</head>
<body>
<div class="bg-gradient"></div>
<div class="container">
  <header>
    <h1 class="logo">SHΞN<span class="tm">™</span><span class="accent">Bypass</span></h1>
    <p class="tagline">تحلیل آزاد. اتصال بدون مرز.</p>
  </header>

  <div class="hero">
    <div class="hero-card">
      <h2>به استخر مشارکتی بپیوندید</h2>
      <p>ورکر کلودفلر خود را به استخر SHΞN متصل کنید و در ازای آن، به تمام نودهای فعال استخر دسترسی پیدا کنید.</p>
      <div class="features">
        <div class="feature"><span class="icon">⚡</span><span>VLESS / WS / gRPC / XHTTP</span></div>
        <div class="feature"><span class="icon">🌐</span><span>استخر نودهای مشارکتی</span></div>
        <div class="feature"><span class="icon">🔒</span><span>رمزگذاری TLS</span></div>
        <div class="feature"><span class="icon">📦</span><span>سابلینک خودکار</span></div>
      </div>
      <div class="cta">
        <a href="/login" class="btn btn-primary">ورود / ثبت‌نام</a>
      </div>
    </div>
  </div>

  <section class="how-it-works">
    <h2>چطور کار می‌کند؟</h2>
    <div class="steps">
      <div class="step"><div class="step-num">۱</div><h3>ثبت‌نام</h3><p>یک حساب کاربری بسازید.</p></div>
      <div class="step"><div class="step-num">۲</div><h3>اتصال توکن</h3><p>توکن API کلودفلر خود را وارد کنید.</p></div>
      <div class="step"><div class="step-num">۳</div><h3>دیپلوی خودکار</h3><p>ورکر SHΞN روی اکانت شما نصب می‌شود.</p></div>
      <div class="step"><div class="step-num">۴</div><h3>استخر مشترک</h3><p>ورکر شما به استخر می‌پیوندد و سابلینک شما شامل تمام نودها می‌شود.</p></div>
    </div>
  </section>

  <footer>
    <p>${BRAND} — قدرت‌گرفته از Cloudflare Workers</p>
  </footer>
</div>
</body>
</html>`;
}

function loginPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${BRAND} — ورود</title>
<style>${css()}</style>
</head>
<body>
<div class="bg-gradient"></div>
<div class="container">
  <header>
    <h1 class="logo">SHΞN<span class="tm">™</span><span class="accent">Bypass</span></h1>
  </header>

  <div class="auth-card">
    <div class="tabs">
      <button class="tab active" onclick="switchTab('login')">ورود</button>
      <button class="tab" onclick="switchTab('register')">ثبت‌نام</button>
    </div>

    <!-- Login Form -->
    <form id="login-form" class="auth-form" onsubmit="return doLogin(event)">
      <input type="text" name="username" placeholder="نام کاربری" required>
      <input type="password" name="password" placeholder="رمز عبور" required>
      <button type="submit" class="btn btn-primary">ورود</button>
      <p class="error" id="login-error"></p>
    </form>

    <!-- Register Form -->
    <form id="register-form" class="auth-form hidden" onsubmit="return doRegister(event)">
      <input type="text" name="username" placeholder="نام کاربری" required>
      <input type="password" name="password" placeholder="رمز عبور (حداقل ۶ کاراکتر)" required>
      <button type="submit" class="btn btn-primary">ثبت‌نام</button>
      <p class="error" id="register-error"></p>
    </form>
  </div>
</div>

<script>
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
  if (tab === 'login') {
    document.querySelector('.tab:first-child').classList.add('active');
    document.getElementById('login-form').classList.remove('hidden');
  } else {
    document.querySelector('.tab:last-child').classList.add('active');
    document.getElementById('register-form').classList.remove('hidden');
  }
}

async function doLogin(e) {
  e.preventDefault();
  const form = e.target;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({username: form.username.value, password: form.password.value})
  });
  const data = await res.json();
  if (data.ok) {
    document.cookie = 'shen_token=' + data.token + '; path=/; max-age=3600';
    window.location.href = '/panel';
  } else {
    document.getElementById('login-error').textContent = data.error;
  }
  return false;
}

async function doRegister(e) {
  e.preventDefault();
  const form = e.target;
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({username: form.username.value, password: form.password.value})
  });
  const data = await res.json();
  if (data.ok) {
    document.cookie = 'shen_token=' + data.token + '; path=/; max-age=3600';
    window.location.href = '/panel';
  } else {
    document.getElementById('register-error').textContent = data.error;
  }
  return false;
}
</script>
</body>
</html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${BRAND} — داشبورد</title>
<style>${css()}</style>
</head>
<body>
<div class="bg-gradient"></div>
<div class="container">
  <header>
    <h1 class="logo">SHΞN<span class="tm">™</span><span class="accent">Bypass</span></h1>
    <button class="btn btn-ghost" onclick="logout()">خروج</button>
  </header>

  <div class="dashboard">
    <div class="stats" id="stats">
      <div class="stat-card">
        <div class="stat-value" id="pool-size">—</div>
        <div class="stat-label">نودهای فعال استخر</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="my-status">—</div>
        <div class="stat-label">وضعیت نود شما</div>
      </div>
    </div>

    <div class="panel-section" id="deploy-section">
      <h2>اتصال ورکر کلودفلر</h2>
      <p>توکن API کلودفلر خود را وارد کنید تا ورکر SHΞN روی اکانت شما دیپلوی شود.</p>
      <div class="token-info">
        <details>
          <summary>چطور توکن بسازم؟</summary>
          <ol>
            <li>به <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">صفحه API Tokens</a> بروید</li>
            <li>روی "Create Token" کلیک کنید</li>
            <li>قالب "Edit Cloudflare Workers" را انتخاب کنید</li>
            <li>توکن را کپی و اینجا پیست کنید</li>
          </ol>
        </details>
      </div>
      <form onsubmit="return deploy(event)">
        <input type="password" id="cf-token" placeholder="Cloudflare API Token" required>
        <button type="submit" class="btn btn-primary">دیپلای ورکر</button>
      </form>
      <p class="status-msg" id="deploy-status"></p>
    </div>

    <div class="panel-section hidden" id="sub-section">
      <h2>سابلینک شما</h2>
      <p>این لینک را در کلاینت Xray/V2ray خود وارد کنید. این سابلینک شامل تمام نودهای فعال استخر است.</p>
      <div class="sub-box">
        <input type="text" id="sub-url" readonly>
        <button class="btn btn-secondary" onclick="copySub()">کپی</button>
      </div>
      <div class="sub-info">
        <p>تعداد کانفیگ‌ها: <span id="config-count">—</span></p>
        <p>ریمارک: <code>${REMARK}</code></p>
      </div>
    </div>

    <div class="panel-section">
      <h2>نودهای استخر</h2>
      <div class="node-list" id="node-list">در حال بارگذاری...</div>
    </div>
  </div>
</div>

<script>
const API = '';

async function loadMe() {
  const res = await fetch('/api/me');
  if (!res.ok) { window.location.href = '/login'; return; }
  const data = await res.json();
  if (!data.ok) { window.location.href = '/login'; return; }

  document.getElementById('pool-size').textContent = data.poolSize;
  document.getElementById('my-status').textContent = data.user.deployed ? 'فعال ✓' : 'غیرفعال';

  if (data.user.deployed) {
    document.getElementById('deploy-section').classList.add('hidden');
    document.getElementById('sub-section').classList.remove('hidden');
    document.getElementById('sub-url').value = data.subscriptionUrl;
  }

  loadPool();
}

async function loadPool() {
  const res = await fetch('/api/pool');
  const data = await res.json();
  if (data.ok) {
    const list = document.getElementById('node-list');
    document.getElementById('config-count').textContent = data.count * 3;
    if (data.nodes.length === 0) {
      list.innerHTML = '<p class="muted">هنوز نود فعالی وجود ندارد.</p>';
      return;
    }
    list.innerHTML = data.nodes.map(n => 
      '<div class="node-item"><span class="node-dot active"></span><span>' + 
      (n.workerDomain || 'unknown') + '</span><span class="muted">' + 
      new Date(n.lastHeartbeat).toLocaleTimeString('fa-IR') + '</span></div>'
    ).join('');
  }
}

async function deploy(e) {
  e.preventDefault();
  const status = document.getElementById('deploy-status');
  status.textContent = 'در حال دیپلای...';
  status.className = 'status-msg loading';

  const res = await fetch('/api/deploy', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({cfToken: document.getElementById('cf-token').value})
  });
  const data = await res.json();

  if (data.ok) {
    status.textContent = '✓ ورکر با موفقیت دیپلای شد و به استخر پیوست!';
    status.className = 'status-msg success';
    setTimeout(() => location.reload(), 2000);
  } else {
    status.textContent = '✗ ' + (data.error || 'خطا در دیپلای');
    status.className = 'status-msg error';
  }
  return false;
}

function copySub() {
  const input = document.getElementById('sub-url');
  input.select();
  document.execCommand('copy');
  alert('کپی شد!');
}

async function logout() {
  await fetch('/api/logout', {method:'POST'});
  window.location.href = '/';
}

loadMe();
setInterval(loadPool, 10000);
</script>
</body>
</html>`;
}

function css() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
:root {
  --bg: #0a0a0f;
  --bg-card: #12121a;
  --accent: #00ffd5;
  --accent2: #7c3aed;
  --accent-glow: rgba(0,255,213,0.3);
  --text: #e0e0e8;
  --text-muted: #6b6b80;
  --border: #1e1e2e;
  --danger: #ff4757;
  --success: #2ed573;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', Tahoma, sans-serif;
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
}
.bg-gradient {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: radial-gradient(ellipse at 20% 0%, rgba(124,58,237,0.15), transparent 50%),
              radial-gradient(ellipse at 80% 100%, rgba(0,255,213,0.1), transparent 50%);
  z-index: -1;
}
.container { max-width: 800px; margin: 0 auto; padding: 20px; }
header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; }
.logo { font-size: 1.8rem; font-weight: 800; letter-spacing: -1px; }
.logo .tm { font-size: 0.5em; vertical-align: super; color: var(--accent); }
.logo .accent { color: var(--accent); }
.tagline { color: var(--text-muted); margin-top: 5px; font-size: 0.95rem; }
.hero { margin: 40px 0; }
.hero-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 32px;
  text-align: center;
}
.hero-card h2 { font-size: 1.5rem; margin-bottom: 12px; }
.hero-card p { color: var(--text-muted); margin-bottom: 24px; line-height: 1.6; }
.features { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 24px 0; }
.feature { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.03); padding: 10px 14px; border-radius: 10px; font-size: 0.9rem; }
.feature .icon { font-size: 1.2rem; }
.cta { margin-top: 24px; }
.btn {
  display: inline-block; padding: 12px 28px; border: none; border-radius: 10px;
  font-size: 1rem; cursor: pointer; text-decoration: none; transition: all 0.2s;
  font-family: inherit;
}
.btn-primary { background: var(--accent); color: #000; font-weight: 600; }
.btn-primary:hover { box-shadow: 0 0 20px var(--accent-glow); transform: translateY(-1px); }
.btn-secondary { background: var(--bg-card); color: var(--accent); border: 1px solid var(--accent); }
.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
.btn-ghost:hover { color: var(--text); border-color: var(--text-muted); }
.how-it-works { margin: 40px 0; }
.how-it-works h2 { text-align: center; margin-bottom: 24px; }
.steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.step { text-align: center; background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 20px 12px; }
.step-num { width: 36px; height: 36px; background: var(--accent2); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px; font-weight: 700; }
.step h3 { font-size: 0.95rem; margin-bottom: 6px; }
.step p { font-size: 0.8rem; color: var(--text-muted); }
footer { text-align: center; padding: 30px 0; color: var(--text-muted); font-size: 0.85rem; }
.auth-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; padding: 32px; max-width: 400px; margin: 40px auto; }
.tabs { display: flex; gap: 0; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
.tab { flex: 1; padding: 12px; background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 1rem; font-family: inherit; border-bottom: 2px solid transparent; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.auth-form { display: flex; flex-direction: column; gap: 16px; }
.auth-form input { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; color: var(--text); font-size: 1rem; font-family: inherit; }
.auth-form input:focus { outline: none; border-color: var(--accent); }
.auth-form button { margin-top: 8px; }
.error { color: var(--danger); font-size: 0.85rem; min-height: 1em; }
.hidden { display: none !important; }
.dashboard { display: flex; flex-direction: column; gap: 24px; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.stat-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; text-align: center; }
.stat-value { font-size: 2rem; font-weight: 800; color: var(--accent); }
.stat-label { color: var(--text-muted); font-size: 0.85rem; margin-top: 4px; }
.panel-section { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.panel-section h2 { font-size: 1.2rem; margin-bottom: 12px; }
.panel-section p { color: var(--text-muted); margin-bottom: 16px; line-height: 1.6; }
.token-info { margin-bottom: 16px; }
.token-info summary { cursor: pointer; color: var(--accent); font-size: 0.9rem; }
.token-info ol { margin: 12px 20px; color: var(--text-muted); font-size: 0.85rem; line-height: 1.8; }
.token-info a { color: var(--accent); }
.panel-section form { display: flex; flex-direction: column; gap: 12px; }
.panel-section input { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; color: var(--text); font-family: inherit; }
.panel-section input:focus { outline: none; border-color: var(--accent); }
.status-msg { margin-top: 12px; font-size: 0.9rem; }
.status-msg.loading { color: var(--accent); }
.status-msg.success { color: var(--success); }
.status-msg.error { color: var(--danger); }
.sub-box { display: flex; gap: 8px; }
.sub-box input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 14px; color: var(--text); font-family: monospace; font-size: 0.85rem; }
.sub-info { margin-top: 12px; font-size: 0.85rem; color: var(--text-muted); }
.sub-info code { background: var(--bg); padding: 2px 8px; border-radius: 4px; color: var(--accent); }
.node-list { display: flex; flex-direction: column; gap: 8px; }
.node-item { display: flex; align-items: center; gap: 12px; background: var(--bg); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border); }
.node-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); }
.node-dot.active { box-shadow: 0 0 8px var(--success); }
.muted { color: var(--text-muted); }
@media (max-width: 600px) {
  .features { grid-template-columns: 1fr; }
  .steps { grid-template-columns: 1fr 1fr; }
  .stats { grid-template-columns: 1fr; }
}
`;
}
