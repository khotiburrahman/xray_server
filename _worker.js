import { connect } from "cloudflare:sockets";

const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000"; 
const GITHUB_PROXY_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";

let GLOBAL_PROXIES = [];
let LAST_FETCH = 0;

async function getProxies(ctx) {
  const fetchProxies = async () => {
    try {
      const res = await fetch(GITHUB_PROXY_URL, { cf: { cacheTtl: 3600 } });
      if (res.status === 200) {
        const text = await res.text();
        const lines = text.split("\n").filter(Boolean);
        const temp = [];
        for (const line of lines) {
          const parts = line.split(",");
          if (parts.length >= 2) {
            temp.push({ 
              prxIP: parts[0].trim(), 
              prxPort: parseInt(parts[1].trim()) || 443, 
              country: parts[2] ? parts[2].trim() : "UN", 
              org: parts[3] ? parts[3].trim() : "Unknown" 
            });
          }
        }
        if (temp.length > 0) {
          GLOBAL_PROXIES = temp;
          LAST_FETCH = Date.now();
        }
      }
    } catch (e) {}
  };

  if (GLOBAL_PROXIES.length === 0 || Date.now() - LAST_FETCH > 3600000) {
    if (GLOBAL_PROXIES.length === 0) {
      await fetchProxies(); // Tunggu sebentar jika kosong
    } else {
      ctx.waitUntil(fetchProxies()); // Update di latar belakang jika sudah ada cache
    }
  }
  return GLOBAL_PROXIES;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();
      const finalUUID = env.UUID || DEFAULT_UUID;
      const proxyList = await getProxies(ctx);

      const countryPathMatch = url.pathname.match(/^\/([a-zA-Z]{2})(\d*)$/);
      const isUpgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket" || 
                        request.headers.get("Upgrade")?.toLowerCase() === "httpupgrade";

      if (countryPathMatch && isUpgrade) {
        const targetCountry = countryPathMatch[1].toUpperCase();
        const targetIndex = parseInt(countryPathMatch[2]) - 1 || 0;

        let targetIP = "1.1.1.1";
        let targetPort = 443;

        if (targetCountry !== "CF") {
          const filteredProxies = proxyList.filter(p => p.country.toUpperCase() === targetCountry);
          if (filteredProxies.length > 0) {
            const selectedProxy = filteredProxies[targetIndex] || filteredProxies[targetIndex % filteredProxies.length];
            targetIP = selectedProxy.prxIP;
            targetPort = selectedProxy.prxPort;
          }
        }

        return await multiProtocolHandler(request, targetIP, targetPort);
      }

      if (path === "/sub") {
        const subContent = generateSubscription(proxyList, finalUUID, url.hostname);
        return new Response(btoa(subContent), {
          status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      if (path === "/") {
        if (proxyList.length === 0) {
          return new Response("Gagal memuat data. Sila refresh halaman.", { status: 500 });
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

async function multiProtocolHandler(request, targetIP, targetPort) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocket = null;
  let writer = null;
  let isFirstChunk = true;

  webSocket.addEventListener("message", async (event) => {
    try {
      const buffer = new Uint8Array(event.data);

      if (!isFirstChunk && writer) {
        await writer.write(buffer);
        return;
      }

      if (buffer.length === 0) return;
      isFirstChunk = false;

      let isTrojan = buffer.length >= 58 && buffer[56] === 0x0d && buffer[57] === 0x0a;
      let isVless = buffer[0] === 0x00;

      remoteSocket = connect({ hostname: targetIP, port: targetPort });
      writer = remoteSocket.writable.getWriter();

      if (isVless) {
        webSocket.send(new Uint8Array([0, 0])); 
      } else if (isTrojan) {
        webSocket.send(new Uint8Array([0, 0, 0x0d, 0x0a])); 
      }

      await writer.write(buffer);
      remoteSocketToWS(remoteSocket, webSocket);
    } catch (e) {
      safeClose(webSocket);
    }
  });

  webSocket.addEventListener("close", () => safeClose(webSocket));
  webSocket.addEventListener("error", () => safeClose(webSocket));

  return new Response(null, { status: 101, webSocket: client });
}

// Bypassing TransformStream error with explicit reader iteration
async function remoteSocketToWS(remoteSocket, webSocket) {
  try {
    const reader = remoteSocket.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (webSocket.readyState === 1) {
        webSocket.send(value);
      }
    }
  } catch (e) {
    safeClose(webSocket);
  }
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
