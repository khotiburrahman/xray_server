import { connect } from "cloudflare:sockets";

// IP Proxy Cloudflare default untuk bypass jika diperlukan (opsional).
// Jika ingin koneksi langsung, biarkan string kosong "".
const DEFAULT_PROXY_IP = ""; 

export default {
  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("VLESS/Trojan Worker is running.", { status: 200 });
    }
    return await websocketHandler(request);
  }
};

async function websocketHandler(request) {
  const { 0: client, 1: webSocket } = new WebSocketPair();
  webSocket.accept();
  let remoteSocket = null;

  const readable = new ReadableStream({
    start(controller) {
      webSocket.addEventListener("message", (e) => controller.enqueue(e.data));
      webSocket.addEventListener("close", () => {
        controller.close();
        if (remoteSocket) remoteSocket.close();
      });
      webSocket.addEventListener("error", (e) => controller.error(e));
    },
    cancel() { 
      webSocket.close(); 
    }
  });

  readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      
      const buffer = new Uint8Array(chunk);
      let address = "", port = 0, rawDataIndex = 0, responseHeader = null;

      // 1. Sniff Trojan (Cek CRLF di byte 56-57)
      if (buffer.byteLength >= 58 && buffer[56] === 0x0d && buffer[57] === 0x0a) {
        const addrType = buffer[59];
        let addrLen = 0, addrIdx = 60;
        
        if (addrType === 1) { // IPv4
          addrLen = 4; 
          address = buffer.slice(addrIdx, addrIdx + addrLen).join("."); 
        } else if (addrType === 3) { // Domain
          addrLen = buffer[addrIdx]; addrIdx++; 
          address = new TextDecoder().decode(buffer.slice(addrIdx, addrIdx + addrLen)); 
        } else if (addrType === 4) { // IPv6 (Sederhana)
          addrLen = 16; 
          address = "[IPv6-Not-Fully-Parsed]"; 
        }
        
        const portIdx = addrIdx + addrLen;
        port = new DataView(chunk).getUint16(portIdx, false);
        rawDataIndex = portIdx + 4; // Lewati port (2) + CRLF (2)
      }
      // 2. Sniff VLESS (Byte awal 0)
      else if (buffer.byteLength >= 18 && buffer[0] === 0) {
        const optLen = buffer[17];
        const portIdx = 18 + optLen + 1;
        port = new DataView(chunk).getUint16(portIdx, false);
        
        const addrIdx = portIdx + 2;
        const addrType = buffer[addrIdx];
        let addrValIdx = addrIdx + 1, addrLen = 0;

        if (addrType === 1) { 
          addrLen = 4; 
          address = buffer.slice(addrValIdx, addrValIdx + addrLen).join("."); 
        } else if (addrType === 2) { 
          addrLen = buffer[addrValIdx]; addrValIdx++; 
          address = new TextDecoder().decode(buffer.slice(addrValIdx, addrValIdx + addrLen)); 
        } else if (addrType === 3) { 
          addrLen = 16; 
          address = "[IPv6-Not-Fully-Parsed]"; 
        }
        
        rawDataIndex = addrValIdx + addrLen;
        responseHeader = new Uint8Array([buffer[0], 0]);
      } else {
        webSocket.close();
        return;
      }

      // Tentukan target Outbound
      // Gunakan Proxy IP jika address adalah IP/Domain yang terblokir secara internal oleh CF.
      // Default: gunakan address langsung hasil parsing.
      const targetHost = DEFAULT_PROXY_IP ? DEFAULT_PROXY_IP : address;

      remoteSocket = connect({ hostname: targetHost, port: port });
      const writer = remoteSocket.writable.getWriter();
      await writer.write(buffer.slice(rawDataIndex));
      writer.releaseLock();

      remoteSocket.readable.pipeTo(new WritableStream({
        async write(remoteChunk) {
          if (webSocket.readyState === 1) {
            if (responseHeader) {
              webSocket.send(await new Blob([responseHeader, remoteChunk]).arrayBuffer());
              responseHeader = null;
            } else {
              webSocket.send(remoteChunk);
            }
          }
        }
      })).catch(() => {});
    }
  })).catch(() => {});

  return new Response(null, { status: 101, webSocket: client });
}
