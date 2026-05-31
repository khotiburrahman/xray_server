import { connect } from "cloudflare:sockets";

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000"; 
const GITHUB_PROXY_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();

      if (path === "/sync-db") {
        const syncResult = await syncProxiesToCache(env);
        return new Response(JSON.stringify(syncResult), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }

      let proxyList = [];
      if (env.PROXY_DB) {
        proxyList = await env.PROXY_DB.get("PROXIES_JSON", "json") || [];
      }

      const finalUUID = env.UUID || DEFAULT_UUID;
      const countryPathMatch = url.pathname.match(/^\/([a-zA-Z]{2})(\d+)$/);
      
      if (countryPathMatch && request.headers.get("Upgrade") === "websocket") {
        const targetCountry = countryPathMatch[1].toUpperCase();
        const targetIndex = parseInt(countryPathMatch[2]) - 1;

        const filteredProxies = proxyList.filter(p => p.country.toUpperCase() === targetCountry);
        let selectedProxy = null;
        if (filteredProxies.length > 0) {
          selectedProxy = filteredProxies[targetIndex] || filteredProxies[targetIndex % filteredProxies.length];
        }

        if (selectedProxy) {
          globalThis.PROXY_IP = selectedProxy.prxIP;
          globalThis.PROXY_PORT = selectedProxy.prxPort;
        } else {
          globalThis.PROXY_IP = "1.1.1.1";
          globalThis.PROXY_PORT = "443";
        }

        return await websocketHandler(request, finalUUID);
      }

      if (path === "/sub") {
        const subContent = generateSubscription(proxyList, finalUUID, url.hostname);
        return new Response(btoa(subContent), {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      return new Response(`EdTunnel Mini Terbuka.\nSub: https://${url.hostname}/sub\nPath: /sg1, /id1, /my1`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      });

    } catch (err) {
      return new Response(`Error: ${err.toString()}`, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncProxiesToCache(env));
  }
};

async function syncProxiesToCache(env) {
  if (!env.PROXY_DB) return { error: "Binding KV 'PROXY_DB' tidak ditemukan!" };
  try {
    const response = await fetch(GITHUB_PROXY_URL, { headers: { "User-Agent": "Cloudflare Worker" } });
    if (response.status !== 200) throw new Error("Gagal mengambil data dari GitHub");

    const text = await response.text();
    if (!text.trim()) throw new Error("Data GitHub kosong");

    const oldText = await env.PROXY_DB.get("HOMEPAGE_CACHE");
    if (text === oldText) {
      return { status: "skipped", message: "Data identik." };
    }

    const lines = text.split("\n").filter(Boolean);
    const proxies = [];

    for (const line of lines) {
      const parts = line.split(",");
      if (parts.length >= 2) {
        proxies.push({ 
          prxIP: parts[0].trim(), 
          prxPort: parts[1].trim(), 
          country: parts[2] ? parts[2].trim() : "UN", 
          org: parts[3] ? parts[3].trim() : "Unknown" 
        });
      }
    }

    if (proxies.length === 0) throw new Error("Format tidak valid");

    await env.PROXY_DB.put("PROXIES_JSON", JSON.stringify(proxies));
    await env.PROXY_DB.put("HOMEPAGE_CACHE", text);
    return { status: "success", total: proxies.length };
  } catch (err) {
    return { status: "failed", message: `Gagal memperbarui. Menggunakan data lama. Error: ${err.message}` };
  }
}

function generateSubscription(proxyList, uuid, host) {
  const result = [];
  const countryCounter = {};
  for (const prx of proxyList) {
    const cc = prx.country.toLowerCase();
    if (!countryCounter[cc]) countryCounter[cc] = 0;
    countryCounter[cc]++;
    const vlessPath = `/${cc}${countryCounter[cc]}`;
    const vlessLink = `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(vlessPath)}#${prx.org} [${prx.country.toUpperCase()}-${countryCounter[cc]}]`;
    result.push(vlessLink);
  }
  return result.join("\n");
}

async function websocketHandler(request, uuid) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocket = null;
  let isFirstChunk = true;

  const readableStream = new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", event => controller.enqueue(event.data));
      webSocket.addEventListener("close", () => safeClose(webSocket));
      webSocket.addEventListener("error", () => safeClose(webSocket));
    }
  });

  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      // Validasi & Parsing Header VLESS asli (Ciri khas EdTunnel stabil)
      const buffer = new Uint8Array(chunk);
      if (buffer[0] !== 0) return safeClose(webSocket); // Versi VLESS harus 0

      // Mengambil bagian data murni setelah header VLESS dilewati
      // EdTunnel membuang info command/port bawaan client karena kita menggunakan IP hasil filter GitHub
      const targetIP = globalThis.PROXY_IP || "1.1.1.1";
      const targetPort = parseInt(globalThis.PROXY_PORT) || 443;

      try {
        remoteSocket = connect({ hostname: targetIP, port: targetPort });
        
        // Kirim VLESS response header standard (Kunci utama agar v2rayNG terhubung sukses)
        webSocket.send(new Uint8Array([0, 0])); 

        // Jalankan pompa data dua arah
        remoteSocket.readable.pipeTo(new WritableStream({
          write(data) {
            if (webSocket.readyState === 1) webSocket.send(data);
          },
          close() { safeClose(webSocket); },
          abort() { safeClose(webSocket); }
        }));
      } catch (e) {
        safeClose(webSocket);
      }
    }
  })).catch(() => {});

  return new Response(null, { status: 101, webSocket: client });
}

function safeClose(ws) {
  try { if (ws.readyState === 1 || ws.readyState === 2) ws.close(); } catch (e) {}
}
