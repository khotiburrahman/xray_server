import { connect } from "cloudflare:sockets";

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000"; 
const GITHUB_PROXY_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";

// Variabel internal untuk menyimpan cache di RAM Worker
let GLOBAL_PROXY_CACHE = null;
let LAST_CACHE_TIME = 0;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();
      const finalUUID = env.UUID || DEFAULT_UUID;
      const currentTime = Date.now();

      // 1. MEMORY CACHE LOGIC: Ambil dari RAM jika belum lewat 1 jam (3600000 ms)
      if (!GLOBAL_PROXY_CACHE || (currentTime - LAST_CACHE_TIME > 3600000)) {
        try {
          const response = await fetch(GITHUB_PROXY_URL, { 
            headers: { "User-Agent": "Cloudflare Worker" },
            cf: { cacheEverything: true, cacheTtl: 3600 } 
          });
          
          if (response.status === 200) {
            const text = await response.text();
            const lines = text.split("\n").filter(Boolean);
            const tempValues = [];

            for (const line of lines) {
              const parts = line.split(",");
              if (parts.length >= 2) {
                tempValues.push({ 
                  prxIP: parts[0].trim(), 
                  prxPort: parts[1].trim(), 
                  country: parts[2] ? parts[2].trim() : "UN", 
                  org: parts[3] ? parts[3].trim() : "Unknown" 
                });
              }
            }
            
            // Simpan ke RAM Worker jika sukses parsing
            if (tempValues.length > 0) {
              GLOBAL_PROXY_CACHE = tempValues;
              LAST_CACHE_TIME = currentTime;
            }
          }
        } catch (e) {
          // Jika gagal, biarkan menggunakan cache lama yang ada di RAM
        }
      }

      // Gunakan data dari RAM (Sangat cepat, hemat waktu CPU < 1ms)
      const proxyList = GLOBAL_PROXY_CACHE || [];

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

      // Halaman Utama: List Proxy
      if (path === "/") {
        if (proxyList.length === 0) {
          return new Response("Gagal memuat data dari memori. Sila refresh halaman.", { status: 500 });
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
// MULTI-PROTOCOL HANDLER (VLESS, VMESS, TROJAN)
// =========================================================
async function multiProtocolHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocket = null;

  const readableStream = new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", event => {
        let data = event.data;
        if (typeof data === "string") {
          data = new TextEncoder().encode(data);
        } else if (data instanceof ArrayBuffer) {
          data = new Uint8Array(data);
        } else if (!(data instanceof Uint8Array)) {
          data = new Uint8Array(data);
        }
        controller.enqueue(data);
      });
      webSocket.addEventListener("close", () => safeClose(webSocket));
      webSocket.addEventListener("error", () => safeClose(webSocket));
    }
  });

  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      const buffer = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(buffer);
        writer.releaseLock();
        return;
      }

      if (buffer.length === 0) return;

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
          async write(data) {
            if (webSocket.readyState === 1) {
              const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
              webSocket.send(arrayBuffer);
            }
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
    result.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=httpupgrade&host=%${host}&path=${encodeURIComponent(pathWS)}#VLESS-HttpUpgrade ${nameTag}`);
    result.push(`trojan://${uuid}@${host}:443?security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(pathWS)}#TROJAN-WS ${nameTag}`);
    result.push(`trojan://${uuid}@${host}:443?security=tls&sni=${host}&type=httpupgrade&host=${host}&path=${encodeURIComponent(pathWS)}#TROJAN-HttpUpgrade ${nameTag}`);

    const vmessJsonWS = { v: "2", ps: `VMESS-WS ${nameTag}`, add: host, port: "443", id: uuid, aid: "0", scy: "none", net: "ws", type: "none", host: host, path: pathWS, tls: "tls", sni: host };
    const vmessJsonUpgrade = { v: "2", ps: `VMESS-HttpUpgrade ${nameTag}`, add: host, port: "443", id: uuid, aid: "0", scy: "none", net: "httpupgrade", type: "none", host: host, path: pathWS, tls: "tls", sni: host };
    result.push("vmess://" + btoa(JSON.stringify(vmessJsonWS)));
    result.push("vmess://" + btoa(JSON.stringify(vmessJsonUpgrade)));
  }
  return result.join("\n");
}
