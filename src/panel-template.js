// SHΞN™Bypass — Panel Worker Template
// This code gets deployed onto EACH USER's Cloudflare account
// It acts as a VLESS proxy node and registers with the SHΞN pool
//
// Supported protocols: VLESS-WS, VLESS-gRPC, VLESS-XHTTP
// Remark: SHΞN™xray

import { connect } from "cloudflare:sockets";

const WIZARD_URL = "__WIZARD_URL__";
const USER_ID = "__USER_ID__";
const PANEL_UUID = "__PANEL_UUID__";
const PROXY_IP = "__PROXY_IP__"; // optional clean IP

const encoder = new TextEncoder();

// ─── VLESS over WebSocket ───
export default {
  async fetch(request, env, ctx) {
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

    // gRPC over HTTP/2
    if (url.pathname.startsWith("/shen-grpc")) {
      if (upgradeHeader === "websocket") {
        return await vlessOverGRPCHandler(request);
      }
      return new Response("gRPC endpoint", { status: 200 });
    }

    // XHTTP (HTTP/2 body streaming)
    if (url.pathname.startsWith("/shen-xhttp")) {
      return await vlessOverXHTTPHandler(request);
    }

    // WebSocket upgrade = VLESS proxy
    if (upgradeHeader === "websocket") {
      return await vlessOverWSHandler(request);
    }

    // Default: simple info page
    return new Response("SHΞN™xray node active", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

// ─── Pool Registration ───
async function registerWithPool(env) {
  let workerDomain = "unknown";
  try {
    workerDomain = new URL(WIZARD_URL).hostname;
  } catch (e) {}

  const payload = {
    userId: USER_ID,
    workerDomain: workerDomain,
    uuid: PANEL_UUID,
    timestamp: Date.now(),
  };

  try {
    await fetch(WIZARD_URL + "/api/heartbeat", {
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
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();
  server.binaryType = "arraybuffer";

  let remoteSocket = null;
  let headerParsed = false;

  server.addEventListener("message", async (event) => {
    try {
      if (!headerParsed) {
        const vlessHeader = parseVlessHeader(event.data);
        if (!vlessHeader) {
          server.close(1000, "invalid vless header");
          return;
        }
        headerParsed = true;

        remoteSocket = connect({
          hostname: vlessHeader.address,
          port: vlessHeader.port,
        });

        await remoteSocket.opened;

        // Send VLESS response header: version(0) + addon length(0)
        server.send(new Uint8Array([0, 0]));

        if (vlessHeader.dataAfterHeader && vlessHeader.dataAfterHeader.byteLength > 0) {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(new Uint8Array(vlessHeader.dataAfterHeader));
          writer.releaseLock();
        }

        // remote -> WS
        remoteSocket.readable.pipeTo(
          new WritableStream({
            write(chunk) {
              server.send(chunk);
            },
            close() {
              try { server.close(); } catch (e) {}
            },
            abort() {
              try { server.close(); } catch (e) {}
            },
          })
        ).catch(() => {
          try { server.close(); } catch (e) {}
        });

        return;
      }

      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(new Uint8Array(event.data));
        writer.releaseLock();
      }
    } catch (e) {
      try { server.close(); } catch (_) {}
    }
  });

  server.addEventListener("close", () => {
    if (remoteSocket) {
      try { remoteSocket.close(); } catch (e) {}
    }
  });

  server.addEventListener("error", () => {
    if (remoteSocket) {
      try { remoteSocket.close(); } catch (e) {}
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── Parse VLESS Header ───
function parseVlessHeader(buffer) {
  const data = buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer).buffer;
  const view = new DataView(data);

  if (view.byteLength < 24) return null;

  const version = view.getUint8(0);
  const uuidBytes = new Uint8Array(data, 1, 16);
  const uuid = formatUUID(uuidBytes);

  if (uuid.toLowerCase() !== PANEL_UUID.toLowerCase()) return null;

  const addonLength = view.getUint8(17);
  let offset = 18 + addonLength;

  if (offset + 4 > view.byteLength) return null;

  const cmd = view.getUint8(offset);
  offset += 1;

  if (cmd !== 1 && cmd !== 2) return null;

  const port = view.getUint16(offset, false);
  offset += 2;

  let address;
  const atype = view.getUint8(offset);
  offset += 1;

  if (atype === 1) {
    if (offset + 4 > view.byteLength) return null;
    address =
      view.getUint8(offset) +
      "." +
      view.getUint8(offset + 1) +
      "." +
      view.getUint8(offset + 2) +
      "." +
      view.getUint8(offset + 3);
    offset += 4;
  } else if (atype === 2) {
    if (offset + 1 > view.byteLength) return null;
    const len = view.getUint8(offset);
    offset += 1;
    if (offset + len > view.byteLength) return null;
    address = new TextDecoder().decode(new Uint8Array(data, offset, len));
    offset += len;
  } else if (atype === 3) {
    if (offset + 16 > view.byteLength) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) {
      parts.push(view.getUint16(offset + i * 2, false).toString(16));
    }
    address = parts.join(":");
    offset += 16;
  } else {
    return null;
  }

  const dataAfterHeader = data.slice(offset);

  return { version, uuid, address, port, dataAfterHeader };
}

function formatUUID(bytes) {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return (
    hex.slice(0, 8) +
    "-" +
    hex.slice(8, 12) +
    "-" +
    hex.slice(12, 16) +
    "-" +
    hex.slice(16, 20) +
    "-" +
    hex.slice(20)
  );
}

// ─── gRPC handler ───
async function vlessOverGRPCHandler(request) {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];

  server.accept();
  server.binaryType = "arraybuffer";

  let remoteSocket = null;
  let headerParsed = false;

  server.addEventListener("message", async (event) => {
    try {
      const raw = new Uint8Array(event.data);
      if (raw.length < 5) return;
      const payload = raw.slice(5);

      if (!headerParsed) {
        const vlessHeader = parseVlessHeader(payload.buffer);
        if (!vlessHeader) return;
        headerParsed = true;

        remoteSocket = connect({
          hostname: vlessHeader.address,
          port: vlessHeader.port,
        });

        await remoteSocket.opened;

        if (vlessHeader.dataAfterHeader && vlessHeader.dataAfterHeader.byteLength > 0) {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(new Uint8Array(vlessHeader.dataAfterHeader));
          writer.releaseLock();
        }

        remoteSocket.readable.pipeTo(
          new WritableStream({
            write(chunk) {
              const framed = new Uint8Array(5 + chunk.byteLength);
              framed[0] = 0;
              new DataView(framed.buffer).setUint32(1, chunk.byteLength, false);
              framed.set(chunk, 5);
              server.send(framed);
            },
            close() {
              try { server.close(); } catch (e) {}
            },
            abort() {
              try { server.close(); } catch (e) {}
            },
          })
        ).catch(() => {
          try { server.close(); } catch (e) {}
        });

        return;
      }

      if (remoteSocket && payload.byteLength > 0) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(payload);
        writer.releaseLock();
      }
    } catch (e) {
      try { server.close(); } catch (_) {}
    }
  });

  server.addEventListener("close", () => {
    if (remoteSocket) {
      try { remoteSocket.close(); } catch (e) {}
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

// ─── XHTTP handler ───
async function vlessOverXHTTPHandler(request) {
  const body = await request.arrayBuffer();
  const vlessHeader = parseVlessHeader(body);

  if (!vlessHeader) {
    return new Response("Bad request", { status: 400 });
  }

  const remoteSocket = connect({
    hostname: vlessHeader.address,
    port: vlessHeader.port,
  });

  await remoteSocket.opened;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  if (vlessHeader.dataAfterHeader && vlessHeader.dataAfterHeader.byteLength > 0) {
    const remoteWriter = remoteSocket.writable.getWriter();
    await remoteWriter.write(new Uint8Array(vlessHeader.dataAfterHeader));
    remoteWriter.releaseLock();
  }

  remoteSocket.readable
    .pipeTo(
      new WritableStream({
        write(chunk) {
          return writer.write(chunk);
        },
        close() {
          return writer.close();
        },
        abort() {
          return writer.close();
        },
      })
    )
    .catch(() => {
      try { writer.close(); } catch (e) {}
    });

  return new Response(readable, {
    headers: {
      "content-type": "application/octet-stream",
    },
  });
}
