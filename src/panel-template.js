// SHΞN™Bypass — Panel Worker Template
// This code gets deployed onto EACH USER's Cloudflare account
// It acts as a VLESS proxy node and registers with the SHΞN pool
//
// Supported protocols: VLESS-WS, VLESS-gRPC, VLESS-XHTTP
// Remark: SHΞN™xray

const WIZARD_URL = "__WIZARD_URL__";
const USER_ID = "__USER_ID__";
const PANEL_UUID = "__PANEL_UUID__";
const PROXY_IP = "__PROXY_IP__"; // optional clean IP

// ─── VLESS over WebSocket ───
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");

    // Heartbeat / registration endpoint
    if (url.pathname === "/shen-register") {
      return registerWithPool(env);
    }

    // Health check
    if (url.pathname === "/shen-health") {
      return Response.json({ ok: true, user: USER_ID, time: Date.now() });
    }

    // WebSocket upgrade = VLESS proxy
    if (upgradeHeader === "websocket") {
      return await vlessOverWSHandler(request);
    }

    // gRPC over HTTP/2
    if (url.pathname.startsWith("/shen-grpc")) {
      return await vlessOverGRPCHandler(request);
    }

    // XHTTP (HTTP/2 body streaming)
    if (url.pathname.startsWith("/shen-xhttp")) {
      return await vlessOverXHTTPHandler(request);
    }

    // Default: simple info page
    return new Response("SHΞN™xray node active", {
      headers: { "content-type": "text/plain" },
    });
  },
};

// ─── Pool Registration ───
async function registerWithPool(env) {
  const workerDomain =
    typeof self !== "undefined" && self.location
      ? self.location.hostname
      : "unknown";

  const payload = {
    userId: USER_ID,
    workerDomain: workerDomain,
    uuid: PANEL_UUID,
    timestamp: Date.now(),
  };

  try {
    await fetch(`${WIZARD_URL}/api/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // silent fail — will retry on next request
  }

  return Response.json({ ok: true });
}

// ─── VLESS over WebSocket ───
async function vlessOverWSHandler(request) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  let vlessHeader = null;
  let remoteSocket = null;

  server.binaryType = "arraybuffer";

  server.addEventListener("message", async (event) => {
    try {
      if (!vlessHeader) {
        // First message = VLESS header
        vlessHeader = parseVlessHeader(event.data);
        if (!vlessHeader) {
          server.close(1000, "invalid vless header");
          return;
        }

        // Connect to destination
        const tcps = connect({
          hostname: vlessHeader.address,
          port: vlessHeader.port,
        });
        remoteSocket = tcps;

        remoteSocket.opened
          .then(() => {
            // Send any remaining data after header
            if (vlessHeader.dataAfterHeader?.byteLength > 0) {
              remoteSocket.write(
                new Uint8Array(vlessHeader.dataAfterHeader)
              );
            }
            pipeRemoteToWS(remoteSocket, server);
          })
          .catch(() => server.close());

        // Pipe WS → remote
        pipeWSToRemote(server, remoteSocket);
      }
    } catch (e) {
      server.close();
    }
  });

  server.addEventListener("close", () => {
    if (remoteSocket) remoteSocket.close();
  });

  server.addEventListener("error", () => {
    if (remoteSocket) remoteSocket.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── Parse VLESS Header ───
function parseVlessHeader(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 24) return null;

  const version = view.getUint8(0);
  const uuidBytes = new Uint8Array(buffer, 1, 16);
  const uuid = formatUUID(uuidBytes);
  if (uuid !== PANEL_UUID) return null;

  const addonLength = view.getUint16(17, true); // little-endian
  let offset = 19 + addonLength;

  if (offset + 2 > view.byteLength) return null;

  const cmd = view.getUint8(offset);
  offset += 1;

  if (cmd !== 1 && cmd !== 2) return null; // TCP=1, UDP=2

  let address, port;
  const atype = view.getUint8(offset);
  offset += 1;

  if (atype === 1) {
    // IPv4
    address = `${view.getUint8(offset)}.${view.getUint8(offset + 1)}.${view.getUint8(offset + 2)}.${view.getUint8(offset + 3)}`;
    offset += 4;
  } else if (atype === 2) {
    // Domain
    const len = view.getUint8(offset);
    offset += 1;
    address = new TextDecoder().decode(
      new Uint8Array(buffer, offset, len)
    );
    offset += len;
  } else if (atype === 3) {
    // IPv6
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(view.getUint16(offset + i * 2).toString(16));
    }
    address = parts.join(":");
    offset += 16;
  } else {
    return null;
  }

  port = view.getUint16(offset, true); // big-endian for port
  offset += 2;

  const dataAfterHeader = buffer.slice(offset);

  return { uuid, address, port, dataAfterHeader };
}

function formatUUID(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Pipe functions ───
async function pipeWSToRemote(ws, remote) {
  ws.addEventListener("message", (event) => {
    try {
      remote.write(new Uint8Array(event.data));
    } catch (e) {}
  });
}

async function pipeRemoteToWS(remote, ws) {
  const reader = remote.readable.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.send(value);
    }
  } catch (e) {
  } finally {
    reader.releaseLock();
    ws.close();
  }
}

// ─── gRPC handler (simplified) ───
async function vlessOverGRPCHandler(request) {
  // gRPC uses HTTP/2 trailers — forward as WebSocket-like stream
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.binaryType = "arraybuffer";

  // Similar to WS but with gRPC framing
  server.addEventListener("message", async (event) => {
    // Strip gRPC framing (5 byte header: compressed flag + 4 byte length)
    const data = new Uint8Array(event.data);
    if (data.length < 5) return;
    const payload = data.slice(5); // skip gRPC header

    // Parse VLESS from payload
    const vlessHeader = parseVlessHeader(payload.buffer);
    if (!vlessHeader) return;

    const remote = connect({
      hostname: vlessHeader.address,
      port: vlessHeader.port,
    });

    remote.opened.then(() => {
      if (vlessHeader.dataAfterHeader?.byteLength > 0) {
        remote.write(new Uint8Array(vlessHeader.dataAfterHeader));
      }
      pipeRemoteToWS(remote, server);
    });

    server.addEventListener("message", (e) => {
      const d = new Uint8Array(e.data);
      if (d.length > 5) remote.write(d.slice(5));
    });
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── XHTTP handler ───
async function vlessOverXHTTPHandler(request) {
  // XHTTP = VLESS over HTTP/2/3 body streaming
  // Client sends VLESS payload as HTTP body, server streams response back
  const body = await request.arrayBuffer();
  const vlessHeader = parseVlessHeader(body);
  if (!vlessHeader) {
    return new Response("Bad request", { status: 400 });
  }

  const remote = connect({
    hostname: vlessHeader.address,
    port: vlessHeader.port,
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  remote.opened.then(async () => {
    if (vlessHeader.dataAfterHeader?.byteLength > 0) {
      remote.write(new Uint8Array(vlessHeader.dataAfterHeader));
    }

    const reader = remote.readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
      }
    } catch (e) {
    } finally {
      writer.close();
    }
  });

  return new Response(readable, {
    headers: {
      "content-type": "application/octet-stream",
    },
  });
}
