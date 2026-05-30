import { connect } from "cloudflare:sockets";

const PROXY_LIST_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";
const BYPASS_DOMAIN_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/blocked_domain.txt";

export default {
  async fetch(request) {
    try {
      const upgradeHeader = request.headers.get("Upgrade");
      const url = new URL(request.url);

      if (url.pathname === "/sync") {
        const syncResult = await forceSync();
        return new Response(`Sync Berhasil!\n\n${syncResult}`, { status: 200 });
      }

      const rawProxies = await getCachedData(PROXY_LIST_URL, "proxy-cache");
      const rawDomains = await getCachedData(BYPASS_DOMAIN_URL, "domain-cache");

      const proxies = parseProxyList(rawProxies);
      const bypassDomains = parseBypassDomains(rawDomains);

      if (upgradeHeader === "websocket") {
        return await websocketHandler(request, proxies, bypassDomains, url.pathname);
      }
      
      if (url.pathname === "/") {
        return new Response(generateDashboard(proxies, bypassDomains), { 
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(`Error: ${err.toString()}`, { status: 500 });
    }
  }
};

async function getCachedData(targetUrl, cacheKeyName, force = false) {
  const cache = caches.default;
  const cacheKey = new Request(`https://fake-host.local/${cacheKeyName}`);
  
  if (!force) {
    let response = await cache.match(cacheKey);
    if (response) return await response.text();
  }

  try {
    const req = await fetch(targetUrl);
    if (req.ok) {
      const text = await req.text();
      const responseToCache = new Response(text, {
        headers: { "Cache-Control": "public, max-age=3600" } 
      });
      await cache.put(cacheKey, responseToCache);
      return text;
    }
  } catch (e) {}
  
  let staleResponse = await cache.match(cacheKey);
  return staleResponse ? await staleResponse.text() : "";
}

async function forceSync() {
  const p = await getCachedData(PROXY_LIST_URL, "proxy-cache", true);
  const d = await getCachedData(BYPASS_DOMAIN_URL, "domain-cache", true);
  
  const proxyCount = parseProxyList(p).length;
  const domainCount = parseBypassDomains(d).length;
  return `Total Proxy Diperbarui: ${proxyCount}\nTotal Domain Dialihkan Diperbarui: ${domainCount}`;
}

function parseProxyList(text) {
  if (!text) return [];
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line && line.includes(','))
    .map(line => {
      const [ip, port, cc, org] = line.split(',');
      return { ip, port: parseInt(port), cc: cc.toUpperCase(), org };
    });
}

function parseBypassDomains(text) {
  if (!text) return [];
  return text.split('\n')
    .map(line => line.trim().toLowerCase())
    .filter(line => line && !line.startsWith('#')); 
}

function generateDashboard(proxies, domains) {
  let html = `<html><head><title>Dashboard Proxy & Pengalihan</title><style>body{font-family:sans-serif;padding:20px}table{border-collapse:collapse;width:100%;margin-bottom:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background-color:#f2f2f2}</style></head><body>`;
  html += `<h2>Dashboard Kaftakahira</h2>`;
  html += `<p>Total Proxy: <b>${proxies.length}</b> | Total Domain Dialihkan: <b>${domains.length}</b></p>`;
  html += `<p><a href="/sync" target="_blank"><button style="padding:10px;cursor:pointer;">Sync Data Sekarang</button></a></p>`;
  
  html += `<h3>Daftar Proxy Aktif</h3>`;
  if (proxies.length === 0) {
    html += `<p><i>Tidak ada proxy aktif saat ini.</i></p>`;
  } else {
    html += `<table><tr><th>IP</th><th>Port</th><th>Kode Negara</th><th>ISP / Org</th></tr>`;
    proxies.forEach(p => {
      html += `<tr><td>${p.ip}</td><td>${p.port}</td><td>${p.cc}</td><td>${p.org}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `<h3>Daftar Domain Dialihkan (Auto-Proxy)</h3>`;
  if (domains.length === 0) {
    html += `<p><i>Tidak ada domain yang diatur untuk dialihkan saat ini.</i></p>`;
  } else {
    html += `<div style="column-count:3;font-size:14px;"><ul>`;
    domains.forEach(d => { html += `<li>${d}</li>`; });
    html += `</ul></div>`;
  }
  html += `</body></html>`;
  
  return html;
}

async function websocketHandler(request, proxies, bypassDomains, pathname) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocketWrapper = { value: null };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk) {
      let view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk instanceof ArrayBuffer ? chunk : await chunk.arrayBuffer());

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

      let selectedProxy = null;
      const requestedCC = pathname.replace('/', '').toUpperCase();
      const isBypassTarget = bypassDomains.some(domain => headerData.addressRemote.toLowerCase().includes(domain));

      // PERBAIKAN LOGIKA DI SINI
      if (requestedCC && requestedCC !== "" && requestedCC !== "SYNC") {
        // Cek apakah input (misal SG1) diawali dengan kode proxy (misal SG)
        const filteredProxies = proxies.filter(p => requestedCC.startsWith(p.cc));
        if (filteredProxies.length > 0) {
          selectedProxy = filteredProxies[Math.floor(Math.random() * filteredProxies.length)];
        }
      } else if (isBypassTarget && proxies.length > 0) {
        selectedProxy = proxies[Math.floor(Math.random() * proxies.length)];
      }

      await handleTCPOutBound(
        remoteSocketWrapper,
        headerData.addressRemote,
        headerData.portRemote,
        headerData.rawClientData,
        webSocket,
        headerData.version,
        selectedProxy
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
        addressLength = 4; addressValue = view.slice(addressValueIndex, addressValueIndex + addressLength).join("."); break;
      case 2:
        addressLength = view[addressValueIndex]; addressValueIndex += 1;
        addressValue = new TextDecoder().decode(view.slice(addressValueIndex, addressValueIndex + addressLength)); break;
      case 3:
        addressLength = 16; const ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(((view[addressValueIndex + i * 2] << 8) | view[addressValueIndex + i * 2 + 1]).toString(16));
        addressValue = ipv6.join(":"); break;
      default: return { hasError: true };
    }

    return { hasError: false, addressRemote: addressValue, portRemote, rawClientData: view.slice(addressValueIndex + addressLength), version: new Uint8Array([version, 0]) };
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
        addressLength = 4; addressValue = view.slice(addressValueIndex, addressValueIndex + addressLength).join("."); break;
      case 3:
        addressLength = view[addressValueIndex]; addressValueIndex += 1;
        addressValue = new TextDecoder().decode(view.slice(addressValueIndex, addressValueIndex + addressLength)); break;
      case 4:
        addressLength = 16; const ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(((view[addressValueIndex + i * 2] << 8) | view[addressValueIndex + i * 2 + 1]).toString(16));
        addressValue = ipv6.join(":"); break;
      default: return { hasError: true };
    }

    const portIndex = addressValueIndex + addressLength;
    const portRemote = (view[portIndex] << 8) | view[portIndex + 1];

    return { hasError: false, addressRemote: addressValue, portRemote, rawClientData: view.slice(portIndex + 4), version: null };
  } catch (e) { return { hasError: true }; }
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxy) {
  try {
    // KUNCI PERBAIKAN: Hanya ganti IP tujuan (targetHost).
    // Port harus SELALU menggunakan port tujuan asli (portRemote) seperti standar edgetunnel.
    let targetHost = proxy ? proxy.ip : addressRemote;
    let targetPort = portRemote; 

    const tcpSocket = connect({ hostname: targetHost, port: targetPort });
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
        if (!readableStreamCancel) controller.enqueue(event.data);
      });
      webSocketServer.addEventListener("close", () => {
        if (!readableStreamCancel) controller.close();
      });
      webSocketServer.addEventListener("error", (err) => controller.error(err));

      if (earlyDataHeader) {
        try {
          const parts = earlyDataHeader.split(",");
          const base64Str = (parts.length > 1 ? parts[1].trim() : parts[0].trim()).replace(/-/g, "+").replace(/_/g, "/");
          controller.enqueue(Uint8Array.from(atob(base64Str), (c) => c.charCodeAt(0)));
        } catch (e) {}
      }
    },
    cancel() {
      readableStreamCancel = true;
      if (webSocketServer.readyState === 1) webSocketServer.close();
    }
  });
}
