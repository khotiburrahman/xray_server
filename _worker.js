import { connect } from "cloudflare:sockets";

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("VLESS/Trojan Worker is active.", { status: 200 });
    }
    return await websocketHandler(request);
  }
};

async function websocketHandler(request) {
  const { 0: client, 1: webSocket } = new WebSocketPair();
  webSocket.accept();
  let remoteSocket = null;

  // 1. Ekstrak "Early Data" (Sangat penting untuk V2rayNG/Clash)
  let earlyData = null;
  const protocolHeader = request.headers.get("sec-websocket-protocol");
  if (protocolHeader) {
    try {
      const base64 = protocolHeader.replace(/-/g, "+").replace(/_/g, "/");
      earlyData = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    } catch (e) {}
  }

  let headerParsed = false;

  const readable = new ReadableStream({
    start(controller) {
      if (earlyData) controller.enqueue(earlyData);
      webSocket.addEventListener("message", (e) => controller.enqueue(new Uint8Array(e.data)));
      webSocket.addEventListener("close", () => { controller.close(); if (remoteSocket) remoteSocket.close(); });
      webSocket.addEventListener("error", (e) => controller.error(e));
    },
    cancel() { webSocket.close(); }
  });

  readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (remoteSocket) {
        const writer = remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      if (!headerParsed) {
        const buffer = new Uint8Array(chunk);
        let address = "", port = 0, rawDataIndex = 0, responseHeader = null;

        try {
          // 2a. Sniff Trojan Header
          if (buffer.byteLength >= 58 && buffer[56] === 0x0d && buffer[57] === 0x0a) {
            const addrType = buffer[59];
            let addrIdx = 60, addrLen = 0;
            if (addrType === 1) { addrLen = 4; address = buffer.slice(addrIdx, addrIdx + addrLen).join("."); } 
            else if (addrType === 3) { addrLen = buffer[addrIdx]; addrIdx++; address = new TextDecoder().decode(buffer.slice(addrIdx, addrIdx + addrLen)); } 
            else if (addrType === 4) { addrLen = 16; address = "ipv6"; } // Disederhanakan
            
            const portIdx = addrIdx + addrLen;
            port = (buffer[portIdx] << 8) | buffer[portIdx + 1];
            rawDataIndex = portIdx + 4; 
          }
          // 2b. Sniff VLESS Header
          else if (buffer.byteLength >= 18 && buffer[0] === 0) {
            const optLen = buffer[17];
            const portIdx = 18 + optLen + 1;
            port = (buffer[portIdx] << 8) | buffer[portIdx + 1];
            
            const addrIdx = portIdx + 2;
            const addrType = buffer[addrIdx];
            let addrValIdx = addrIdx + 1, addrLen = 0;

            if (addrType === 1) { addrLen = 4; address = buffer.slice(addrValIdx, addrValIdx + addrLen).join("."); } 
            else if (addrType === 2) { addrLen = buffer[addrValIdx]; addrValIdx++; address = new TextDecoder().decode(buffer.slice(addrValIdx, addrValIdx + addrLen)); } 
            else if (addrType === 3) { addrLen = 16; address = "ipv6"; }
            
            rawDataIndex = addrValIdx + addrLen;
            responseHeader = new Uint8Array([buffer[0], 0]);
          } else {
            throw new Error("Protocol not recognized");
          }
        } catch (err) {
          webSocket.close();
          return;
        }

        headerParsed = true;

        // 3. Sambung ke tujuan asli (Langsung ke Google/Situs target, bukan diputar ke CDN)
        remoteSocket = connect({ hostname: address, port: port });
        const writer = remoteSocket.writable.getWriter();
        await writer.write(buffer.slice(rawDataIndex));
        writer.releaseLock();

        // 4. Kembalikan respons TCP dari target ke klien VPN
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
    }
  })).catch(() => {});

  return new Response(null, { status: 101, webSocket: client });
}
