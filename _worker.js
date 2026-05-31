import { connect } from "cloudflare:sockets";

const BLOCKED_DOMAINS_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/blocked_domain.txt";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get("Upgrade");

      // 1. Endpoint Sinkronisasi (Hanya untuk Routing Domain)
      if (url.pathname === "/sync") {
        return await handleSync(ctx);
      }

      // 2. Halaman Dashboard Teks
      if (url.pathname === "/" && upgradeHeader !== "websocket") {
        return await handleDashboard();
      }

      // 3. Routing Jalur VLESS & Trojan WebSocket
      if (upgradeHeader === "websocket") {
        return await websocketHandler(request, ctx);
      }

      return new Response("Worker VLESS & Trojan Direct (KV Mode) Aktif.", { status: 200 });
    } catch (err) {
      return new Response(`Error: ${err.toString()}`, { status: 500 });
    }
  },

  // Sinkronisasi otomatis via Cron Triggers
  async scheduled(event, env, ctx) {
    await handleSync(ctx);
  }
};

// --- FUNGSI ROUTING & AMBIL DATA (KV DATABASE) ---

async function handleSync(ctx) {
  if (typeof PROXY_DB === "undefined") {
    return new Response(JSON.stringify({
      status: "Gagal",
      error: "Binding PROXY_DB tidak ditemukan di dashboard Cloudflare Anda."
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  }

  const cache = caches.default;
  const reqDomain = new Request(BLOCKED_DOMAINS_URL);
  let dStatus = "Gagal (Menggunakan cache lama)";

  try {
    const resDomain = await fetch(BLOCKED_DOMAINS_URL);
    if (resDomain.ok) {
      const newDomainText = await resDomain.text();
      const cacheResp = new Response(newDomainText, { headers: { "Cache-Control": "max-age=31536000" } });
      ctx.waitUntil(cache.put(reqDomain, cacheResp));
      dStatus = "Berhasil diperbarui";
    }
  } catch (e) {}

  return new Response(JSON.stringify({
    kv_database: "PROXY_DB Terhubung",
    domain_status: dStatus
  }, null, 2), { headers: { "Content-Type": "application/json" } });
}

async function getCachedData() {
  let proxies = [];
  let dText = "";

  // Parsing JSON dari KV PROXY_DB (Filter ID, MY, SG)
  if (typeof PROXY_DB !== "undefined") {
    try {
      const rawKvData = await PROXY_DB.get("ALL_ACTIVE_PROXIES");
      if (rawKvData) {
        const jsonProxy = JSON.parse(rawKvData);
        for (const [key, value] of Object.entries(jsonProxy)) {
          const countryCode = key.substring(0, 2).toUpperCase();
          if (["ID", "MY", "SG"].includes(countryCode)) {
            const splitValue = value.split("-");
            if (splitValue.length === 2) {
              proxies.push({
                ip: splitValue[0].trim(),
                port: splitValue[1].trim(),
                cc: countryCode,
                org: "KV Database"
              });
            }
          }
        }
      }
    } catch (e) {}
  }

  // Ambil data domain blocked dari cache lokal
  const cache = caches.default;
  const dCache = await cache.match(new Request(BLOCKED_DOMAINS_URL));
  if (dCache) dText = await dCache.text();
  else {
    try {
      const r = await fetch(BLOCKED_DOMAINS_URL);
      if (r.ok) dText = await r.text();
    } catch (e) {}
  }

  const domains = dText.split("\n")
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length > 0 && !l.startsWith("#"));

  return { proxies, domains };
}

// --- DASHBOARD ---

async function handleDashboard() {
  const { proxies, domains } = await getCachedData();
  let output = "DAFTAR PROXY AKTIF (KV SYSTEM - ID/MY/SG):\n=======================================\n";
  
  if (proxies.length === 0) {
    output += "(Kosong - Tidak ada proxy ID/MY/SG aktif di KV DB)\n";
  } else {
    proxies.forEach(p => {
      output += `[${p.cc}] ${p.ip}:${p.port}\n`;
    });
  }

  output += "\n=======================\nDOMAIN YANG DI-ROUTE VIA PROXY:\n=======================\n";
  if (domains.length === 0) {
    output += "(Kosong - Semua rute ditangani langsung oleh Cloudflare)\n";
  } else {
    domains.forEach(d => {
      output += `${d}\n`;
    });
  }

  return new Response(output, { 
    status: 200, 
    headers: { "Content-Type": "text/plain; charset=utf-8" } 
  });
}

// --- WEBSOCKET & ROUTING CORE ---

async function websocketHandler(request, ctx) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocketWrapper = { value: null };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk) {
      let view;
      if (chunk instanceof Uint8Array) view = chunk;
      else if (chunk instanceof ArrayBuffer) view = new Uint8Array(chunk);
      else if (typeof chunk === "string") view = new TextEncoder().encode(chunk);
      else if (chunk && typeof chunk.arrayBuffer === "function") view = new Uint8Array(await chunk.arrayBuffer());
      else view = new Uint8Array(chunk);

      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(view);
        writer.releaseLock();
        return;
      }

      const protocol = protocolSniffer(view);
      let headerData = protocol === "trojan" ? readHorseHeader(view) : readNekoHeader(view);

      if (headerData.hasError || !headerData.addressRemote) {
        webSocket.close();
        return;
      }

      const { proxies, domains } = await getCachedData();
      let targetHost = headerData.addressRemote;
      let targetPort = headerData.portRemote;

      const isDomainBlocked = domains.some(domain => targetHost.toLowerCase().endsWith(domain));

      if (isDomainBlocked && proxies.length > 0) {
        const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
        targetHost = randomProxy.ip;
        targetPort = parseInt(randomProxy.port, 10);
      }

      await handleTCPOutBound(
        remoteSocketWrapper,
        targetHost,
        targetPort,
        headerData.rawClientData,
        webSocket,
        headerData.version
      );
    },
    close() {},
    abort() {},
  })).catch(() => {});

  return new Response(null, { status: 101, webSocket: client });
}

function protocolSniffer(view) {
  if (view.length >= 58 && view[56] === 0x0d && view[57] === 0x0a) return "trojan";
  return "vless";
}

function readNekoHeader(view) {
  try {
    if (view.length < 18) return { hasError: true };
    const version = view[0];
    const optLength = view[17];
    const portIndex = 18 + optLength + 1; 

    if (view.length < portIndex + 2) return { hasError: true };
    const portRemote = (view[portIndex] << 8) | view[portIndex + 1];

    let addressIndex = portIndex + 2;
    const addressType = view[addressIndex];
    let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = view.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 2:
        addressLength = view[addressValueIndex];
        addressValueIndex += 1;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = new TextDecoder().decode(view.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3:
        addressLength = 16;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        const ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(((view[addressValueIndex + i * 2] << 8) | view[addressValueIndex + i * 2 + 1]).toString(16));
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true };
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: view.slice(addressValueIndex + addressLength),
      version: new Uint8Array([version, 0])
    };
  } catch (e) { return { hasError: true }; }
}

function readHorseHeader(viewAll) {
  try {
    if (viewAll.length < 58) return { hasError: true };
    const view = viewAll.slice(58);
    if (view.length < 4) return { hasError: true };

    let addressType = view[1];
    let addressLength = 0, addressValueIndex = 2, addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = view.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 3:
        addressLength = view[addressValueIndex];
        addressValueIndex += 1;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = new TextDecoder().decode(view.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4:
        addressLength = 16;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        const ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(((view[addressValueIndex + i * 2] << 8) | view[addressValueIndex + i * 2 + 1]).toString(16));
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true };
    }

    const portIndex = addressValueIndex + addressLength;
    if (view.length < portIndex + 2) return { hasError: true };
    const portRemote = (view[portIndex] << 8) | view[portIndex + 1];

    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: view.slice(portIndex + 4),
      version: null
    };
  } catch (e) { return { hasError: true }; }
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader) {
  try {
    const tcpSocket = connect({ hostname: addressRemote, port: portRemote });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();

    if (responseHeader && webSocket.readyState === 1) {
      webSocket.send(responseHeader);
    }

    tcpSocket.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (webSocket.readyState === 1) webSocket.send(chunk);
      }
    })).catch(() => {
      if (webSocket.readyState === 1) webSocket.close();
    });
  } catch (e) {
    if (webSocket.readyState === 1) webSocket.close();
  }
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocketServer.addEventListener("close", () => {
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener("error", (err) => controller.error(err));

      if (earlyDataHeader) {
        try {
          const parts = earlyDataHeader.split(",");
          const base64Str = (parts.length > 1 ? parts[1].trim() : parts[0].trim()).replace(/-/g, "+").replace(/_/g, "/");
          const decode = atob(base64Str);
          controller.enqueue(Uint8Array.from(decode, (c) => c.charCodeAt(0)));
        } catch (e) {}
      }
    },
    cancel() {
      readableStreamCancel = true;
      if (webSocketServer.readyState === 1) webSocketServer.close();
    }
  });
}
