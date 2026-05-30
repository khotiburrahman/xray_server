import { connect } from "cloudflare:sockets";

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000"; 
const GITHUB_PROXY_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();
      const finalUUID = env.UUID || DEFAULT_UUID;

      // 1. LIVE FETCH: Mengambil data proxy dari GitHub dengan Cache 1 Jam
      let proxyList = [];
      try {
        const response = await fetch(GITHUB_PROXY_URL, { 
          headers: { "User-Agent": "Cloudflare Worker" },
          cf: { cacheEverything: true, cacheTtl: 3600 } 
        });
        if (response.status === 200) {
          const text = await response.text();
          const lines = text.split("\n").filter(Boolean);
          for (const line of lines) {
            const parts = line.split(",");
            if (parts.length >= 2) {
              proxyList.push({ 
                prxIP: parts[0].trim(), 
                prxPort: parts[1].trim(), 
                country: parts[2] ? parts[2].trim() : "UN", 
                org: parts[3] ? parts[3].trim() : "Unknown" 
              });
            }
          }
        }
      } catch (e) {
        // Jika gagal konek ke GitHub, abaikan agar tidak crash
      }

      const countryPathMatch = url.pathname.match(/^\/([a-zA-Z]{2})(\d*)$/);
      const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket" || 
                        request.headers.get("Upgrade")?.toLowerCase() === "httpupgrade";

      if (countryPathMatch && isUpgrade) {
        const targetCountry = countryPathMatch[1].toUpperCase();
        const targetIndex = parseInt(countryPathMatch[2]) - 1 || 0;

        if (targetCountry === "CF") {
          globalThis.PROXY_IP = "1.1.1.1"; 
          globalThis.PROXY_PORT = "443";
        } else {
          const filteredProxies = proxyList.filter(p => p.country.toUpperCase() === targetCountry);
          let selectedProxy = null;
          if (filteredProxies.length > 0) {
            selectedProxy = filteredProxies[targetIndex] || filteredProxies[targetIndex % filteredProxies.length];
          }

          // PERBAIKAN: Variabel sudah diarahkan dengan benar ke 'selectedProxy'
          if (selectedProxy) {
            globalThis.PROXY_IP = selectedProxy.prxIP;
            globalThis.PROXY_PORT = selectedProxy.prxPort;
          } else {
            globalThis.PROXY_IP = "1.1.1.1";
            globalThis.PROXY_PORT = "443";
          }
        }

        return await multiProtocolHandler(request);
      }

      // Jalur Subscription
      if (path === "/sub") {
        const subContent = generateSubscription(proxyList, finalUUID, url.hostname);
        return new Response(btoa(subContent), {
          status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      // Halaman Utama: List Proxy Terurai
      if (path === "/") {
        if (proxyList.length === 0) {
          return new Response("Gagal memuat data dari GitHub atau data kosong.", { status: 500 });
        }
        const viewLines = [];
        const countryCounter = {};
        for (const prx of proxyList) {
          const cc = prx.country.toUpperCase();
          if (!countryCounter[cc]) countryCounter[cc] = 0;
          countryCounter[cc]++;
          viewLines.push(`${cc}${countryCounter[cc]} ${prx.prxIP}-${prx.prxPort} ${prx.org.toUpperCase()}`);
        }
        return new Response(viewLines.join("\n"), {
          status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      return new Response(`Error: ${err.toString()}`, { status: 500 });
    }
  }
};

// =========================================================
// CORE PROTOCOL HANDLER
// =========================================================
async function multiProtocolHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocket = null;

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

      const buffer = new Uint8Array(chunk);
      let isTrojan = false;
      let isVless = false;

      if (buffer.length >= 58 && buffer[56] === 0x0d && buffer[57] === 0x0a) {
        isTrojan = true;
      } else if (buffer[0] === 0x00) {
        isVless = true;
      }

      const targetIP = globalThis.PROXY_IP || "1.1.1.1";
      const targetPort = parseInt(globalThis.PROXY_PORT) || 443;

      try {
        remoteSocket = connect({ hostname: targetIP, port: targetPort });
        
        if (isVless) {
          webSocket.send(new Uint8Array([0, 0])); 
        } else if (isTrojan) {
          webSocket.send(new Uint8Array([0, 0, 0x0d, 0x0a])); 
        }

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

function generateSubscription(proxyList, uuid, host) {
  const result = [];
  result.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent("/cf")}#Cloudflare Anycast WS [CF]`);
  result.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=httpupgrade&host=${host}&path=${encodeURIComponent("/cf")}#Cloudflare Anycast HTTPUpgrade [CF]`);

  const countryCounter = {};
  for (const prx of proxyList) {
    const cc = prx.country.toLowerCase();
    if (!countryCounter[cc]) countryCounter[cc] = 0;
    countryCounter[cc]++;
    
    const pathWS = `/${cc}${countryCounter[cc]}`;
    const nameTag = `${prx.org.toUpperCase()} [${prx.country.toUpperCase()}-${countryCounter[cc]}]`;

    result.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(pathWS)}#VLESS-WS ${nameTag}`);
    result.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=httpupgrade&host=${host}&path=${encodeURIComponent(pathWS)}#VLESS-HttpUpgrade ${nameTag}`);
    result.push(`trojan://${uuid}@${host}:443?security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(pathWS)}#TROJAN-WS ${nameTag}`);
    result.push(`trojan://${uuid}@${host}:443?security=tls&sni=${host}&type=httpupgrade&host=${host}&path=${encodeURIComponent(pathWS)}#TROJAN-HttpUpgrade ${nameTag}`);

    const vmessJsonWS = { v: "2", ps: `VMESS-WS ${nameTag}`, add: host, port: "443", id: uuid, aid: "0", scy: "none", net: "ws", type: "none", host: host, path: pathWS, tls: "tls", sni: host };
    const vmessJsonUpgrade = { v: "2", ps: `VMESS-HttpUpgrade ${nameTag}`, add: host, port: "443", id: uuid, aid: "0", scy: "none", net: "httpupgrade", type: "none", host: host, path: pathWS, tls: "tls", sni: host };
    result.push("vmess://" + btoa(JSON.stringify(vmessJsonWS)));
    result.push("vmess://" + btoa(JSON.stringify(vmessJsonUpgrade)));
  }
  return result.join("\n");
}
