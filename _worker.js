import { connect } from "cloudflare:sockets";

export default {
  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Proxy is running.", { status: 200 });
    }

    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();

    let remoteSocket = null;
    let vlessVersion = null;
    let headerBuffer = new Uint8Array(0);

    const earlyDataHeader = request.headers.get("sec-websocket-protocol");
    const readable = new ReadableStream({
      start(ctrl) {
        webSocket.addEventListener("message", (e) => ctrl.enqueue(e.data));
        webSocket.addEventListener("close", () => ctrl.close());
        
        // Handle Early Data
        if (earlyDataHeader) {
          try {
            const decoded = atob(earlyDataHeader.replace(/-/g, "+").replace(/_/g, "/"));
            ctrl.enqueue(Uint8Array.from(decoded, (c) => c.charCodeAt(0)).buffer);
          } catch (e) {}
        }
      }
    });

    readable.pipeTo(new WritableStream({
      async write(chunk) {
        // 1. Jika socket outbound sudah terbentuk, langsung bypass data
        if (remoteSocket) {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
          return;
        }

        // 2. Kumpulkan kepingan data (mencegah bug fragmentasi dari Clash/Sing-box)
        const chunkArray = new Uint8Array(chunk);
        const newBuf = new Uint8Array(headerBuffer.length + chunkArray.length);
        newBuf.set(headerBuffer, 0);
        newBuf.set(chunkArray, headerBuffer.length);
        headerBuffer = newBuf;

        if (headerBuffer.length < 24) return; // Tunggu data terkumpul

        let rawData;
        
        // 3. Deteksi VLESS
        if (headerBuffer[0] === 0x00) { 
          const ext = headerBuffer[17];
          const aType = headerBuffer[21 + ext];
          let aIdx = 22 + ext;
          const aLen = aType === 1 ? 4 : (aType === 2 ? headerBuffer[aIdx++] : 16);
          
          if (headerBuffer.length < aIdx + aLen) return; 
          
          rawData = headerBuffer.slice(aIdx + aLen);
          vlessVersion = new Uint8Array([headerBuffer[0], 0]);
        } 
        // 4. Deteksi Trojan
        else if (headerBuffer.length >= 58 && headerBuffer[56] === 0x0d && headerBuffer[57] === 0x0a) { 
          const aType = headerBuffer[59];
          let aIdx = 60;
          const aLen = aType === 1 ? 4 : (aType === 3 ? headerBuffer[aIdx++] : 16);
          const rawIdx = aIdx + aLen + 4; // +2 untuk port, +2 untuk \r\n penutup header
          
          if (headerBuffer.length < rawIdx) return;
          
          rawData = headerBuffer.slice(rawIdx);
        } 
        // Protokol tidak dikenali
        else {
          if (headerBuffer.length > 60) webSocket.close();
          return;
        }

        // 5. Arahkan SEMUA koneksi secara paksa ke Cloudflare Outbound
        remoteSocket = connect({ hostname: "1.1.1.1", port: 443 });
        const writer = remoteSocket.writable.getWriter();
        await writer.write(rawData.buffer);
        writer.releaseLock();

        // 6. Kembalikan balasan dari Outbound ke Client
        remoteSocket.readable.pipeTo(new WritableStream({
          async write(c) {
            if (webSocket.readyState === 1) { // Jika koneksi WS masih OPEN
              if (vlessVersion) {
                webSocket.send(await new Blob([vlessVersion, c]).arrayBuffer());
                vlessVersion = null; // Kirim header balasan VLESS hanya 1x
              } else {
                webSocket.send(c);
              }
            }
          }
        })).catch(() => {});
      }
    })).catch(() => {});

    return new Response(null, { status: 101, webSocket: client });
  }
};
