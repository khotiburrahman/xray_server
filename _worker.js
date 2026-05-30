import { connect } from "cloudflare:sockets";

const GITHUB_PROXY_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";
const DEFAULT_UUID = "00000000-0000-0000-0000-000000000000";

let GLOBAL_PROXIES = [];
let LAST_FETCH = 0;

// Sistem Cache Super Ringan (Anti-Timeout)
async function getProxies(ctx) {
  if (GLOBAL_PROXIES.length === 0 || Date.now() - LAST_FETCH > 3600000) {
    const fetcher = fetch(GITHUB_PROXY_URL, { cf: { cacheTtl: 3600 } })
      .then(res => res.text())
      .then(text => {
        const lines = text.split("\n").filter(Boolean);
        const temp = [];
        for (const line of lines) {
          const parts = line.split(",");
          if (parts.length >= 2) {
            temp.push({ 
              ip: parts[0].trim(), 
              port: parseInt(parts[1].trim()) || 443, 
              cc: parts[2] ? parts[2].trim().toUpperCase() : "UN", 
              org: parts[3] ? parts[3].trim() : "Unknown" 
            });
          }
        }
        if (temp.length > 0) {
          GLOBAL_PROXIES = temp;
          LAST_FETCH = Date.now();
        }
      }).catch(() => {});
    
    if (GLOBAL_PROXIES.length === 0) await fetcher;
    else ctx.waitUntil(fetcher);
  }
  return GLOBAL_PROXIES;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase();
      const uuid = env.UUID || DEFAULT_UUID;
      const upgrade = request.headers.get("Upgrade") || "";
      
      // Mendukung WebSocket dan HTTPUpgrade
      const isUpgrade = upgrade.toLowerCase() === "websocket" || upgrade.toLowerCase() === "httpupgrade";
      const proxies = await getProxies(ctx);

      if (isUpgrade) {
        let targetIP = "1.1.1.1";
        let targetPort = 443;

        const match = path.match(/^\/([a-z]{2})(\d*)$/);
        if (match) {
          const cc = match[1].toUpperCase();
          const idx = parseInt(match[2]) - 1 || 0;
          if (cc !== "CF") {
            const filtered = proxies.filter(p => p.cc === cc);
            if (filtered.length > 0) {
              const p = filtered[idx % filtered.length] || filtered[0];
              targetIP = p.ip;
              targetPort = p.port;
            }
          }
        } else if (path === "/cf") {
          targetIP = "1.1.1.1";
          targetPort = 443;
        }

        return await proxyHandler(request, targetIP, targetPort);
      }

      if (path === "/sub") {
        const sub = generateSub(proxies, uuid, url.hostname);
        return new Response(btoa(sub), {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      if (path === "/") {
        if (proxies.length === 0) return new Response("Data kosong dari GitHub.", { status: 500 });
        const lines = [];
        const counter = {};
        for (const p of proxies) {
          if (!counter[p.cc]) counter[p.cc] = 0;
          counter[p.cc]++;
          lines.push(`${p.cc}${counter[p.cc]} ${p.ip}-${p.port} ${p.org.toUpperCase()}`);
        }
        return new Response(lines.join("\n"), {
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

// Inti Proxy: Stabil untuk VLESS & Trojan (v2rayNG & Clash)
async function proxyHandler(request, targetIP, targetPort) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocket = null;
  let writer = null;

  webSocket.addEventListener("message", async (event) => {
    try {
      // PROTEKSI CLASH: Abaikan ping Teks/String dari Clash agar Worker tidak crash
      if (typeof event.data === "string") return; 

      const buffer = new Uint8Array(event.data);
      
      if (!remoteSocket) {
        remoteSocket = connect({ hostname: targetIP, port: targetPort });
        writer = remoteSocket.writable.getWriter();
        
        // Sniffer VLESS: Kirim balasan sukses [0,0] ke klien
        if (buffer[0] === 0x00) {
          webSocket.send(new Uint8Array([0, 0])); 
        } 
        // Untuk Trojan, kita tidak perlu membalas apapun (langsung forward),
        // ini yang membuat Clash Trojan bisa langsung konek tanpa error.
        
        await writer.write(buffer);
        
        // Alirkan data dari server tujuan balik ke aplikasi Anda
        remoteSocket.readable.pipeTo(new WritableStream({
          write(chunk) {
            if (webSocket.readyState === 1) webSocket.send(chunk);
          }
        })).catch(() => {});
      } else {
        await writer.write(buffer);
      }
    } catch (e) {
      if (webSocket.readyState === 1) webSocket.close();
    }
  });

  return new Response(null, { status: 101, webSocket: client });
}

// Generator Subscription VLESS & Trojan
function generateSub(proxies, uuid, host) {
  const res = [];
  res.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=%2Fcf#CF-Anycast-WS`);
  res.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=httpupgrade&host=${host}&path=%2Fcf#CF-Anycast-HTTPUpgrade`);
  
  const counter = {};
  for (const p of proxies) {
    if (!counter[p.cc]) counter[p.cc] = 0;
    counter[p.cc]++;
    const path = `/${p.cc.toLowerCase()}${counter[p.cc]}`;
    const name = `${p.org.toUpperCase()} [${p.cc}-${counter[p.cc]}]`;
    
    res.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(path)}#VLESS-WS-${name}`);
    res.push(`vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=httpupgrade&host=${host}&path=${encodeURIComponent(path)}#VLESS-Upgrade-${name}`);
    
    res.push(`trojan://${uuid}@${host}:443?security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(path)}#TROJAN-WS-${name}`);
    res.push(`trojan://${uuid}@${host}:443?security=tls&sni=${host}&type=httpupgrade&host=${host}&path=${encodeURIComponent(path)}#TROJAN-Upgrade-${name}`);
  }
  return res.join("\n");
}
