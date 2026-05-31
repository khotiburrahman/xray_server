import { connect } from "cloudflare:sockets";

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      console.log("Request bukan WebSocket, menampilkan halaman status.");
      return new Response("VLESS/Trojan Worker is active.", { status: 200 });
    }
    console.log("-----------------------------------------");
    console.log("Request WebSocket diterima, memulai handler...");
    return await websocketHandler(request);
  }
};

async function websocketHandler(request) {
  const { 0: client, 1: webSocket } = new WebSocketPair();
  webSocket.accept();
  let remoteSocket = null;

  // 1. Ekstrak "Early Data"
  let earlyData = null;
  const protocolHeader = request.headers.get("sec-websocket-protocol");
  if (protocolHeader) {
    try {
      const base64 = protocolHeader.replace(/-/g, "+").replace(/_/g, "/");
      earlyData = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      console.log(`[SUKSES] Early Data berhasil diekstrak (Panjang: ${earlyData.byteLength} bytes).`);
    } catch (e) {
      console.error(`[ERROR] Gagal mengekstrak Early Data: ${e.message}`);
    }
  } else {
    console.log("[INFO] Tidak ada Early Data (sec-websocket-protocol kosong).");
  }

  let headerParsed = false;

  const readable = new ReadableStream({
    start(controller) {
      if (earlyData) controller.enqueue(earlyData);
      webSocket.addEventListener("message", (e) => controller.enqueue(new Uint8Array(e.data)));
      webSocket.addEventListener("close", () => { 
        console.log("[INFO] Koneksi WebSocket ditutup oleh klien.");
        controller.close(); 
        if (remoteSocket) remoteSocket.close(); 
      });
      webSocket.addEventListener("error", (e) => {
        console.error(`[ERROR] Terjadi error pada WebSocket klien.`);
        controller.error(e);
      });
    },
    cancel() { 
      console.log("[INFO] Stream dibatalkan (Cancel).");
      webSocket.close(); 
    }
  });

  readable.pipeTo(new WritableStream({
    async write(chunk) {
      // Jika sudah terhubung, langsung teruskan data ke target
      if (remoteSocket) {
        try {
          const writer = remoteSocket.writable.getWriter();
          await writer.write(chunk);
          writer.releaseLock();
        } catch (err) {
          console.error(`[ERROR] Gagal menulis data ke target (remote socket): ${err.message}`);
        }
        return;
      }

      // Parsing header untuk koneksi pertama kali
      if (!headerParsed) {
        const buffer = new Uint8Array(chunk);
        let address = "", port = 0, rawDataIndex = 0, responseHeader = null;
        let protocolName = "";

        try {
          // 2a. Sniff Trojan Header
          if (buffer.byteLength >= 58 && buffer[56] === 0x0d && buffer[57] === 0x0a) {
            protocolName = "Trojan";
            const addrType = buffer[59];
            let addrIdx = 60, addrLen = 0;
            
            if (addrType === 1) { addrLen = 4; address = buffer.slice(addrIdx, addrIdx + addrLen).join("."); } 
            else if (addrType === 3) { addrLen = buffer[addrIdx]; addrIdx++; address = new TextDecoder().decode(buffer.slice(addrIdx, addrIdx + addrLen)); } 
            else if (addrType === 4) { addrLen = 16; address = "ipv6"; }
            
            const portIdx = addrIdx + addrLen;
            port = (buffer[portIdx] << 8) | buffer[portIdx + 1];
            rawDataIndex = portIdx + 4; 
          }
          // 2b. Sniff VLESS Header
          else if (buffer.byteLength >= 18 && buffer[0] === 0) {
            protocolName = "VLESS";
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
            throw new Error("Protokol tidak dikenali atau data terlalu pendek.");
          }
        } catch (err) {
          console.error(`[ERROR] Parsing header gagal: ${err.message}. Byte size: ${buffer.byteLength}`);
          webSocket.close();
          return;
        }

        headerParsed = true;
        console.log(`[SUKSES] Parsing selesai! Protokol: ${protocolName} | Target: ${address}:${port}`);

        // 3. Sambung ke tujuan asli
        try {
          console.log(`[INFO] Sedang menyambungkan TCP ke ${address}:${port}...`);
          remoteSocket = connect({ hostname: address, port: port });
          const writer = remoteSocket.writable.getWriter();
          await writer.write(buffer.slice(rawDataIndex));
          writer.releaseLock();
          console.log(`[SUKSES] Terhubung ke ${address}:${port} dan data awal dikirim.`);
        } catch (err) {
          console.error(`[ERROR] Gagal menyambungkan ke TCP ${address}:${port} -> ${err.message}`);
          webSocket.close();
          return;
        }

        // 4. Kembalikan respons dari target ke klien VPN
        remoteSocket.readable.pipeTo(new WritableStream({
          async write(remoteChunk) {
            if (webSocket.readyState === 1) {
              try {
                if (responseHeader) {
                  webSocket.send(await new Blob([responseHeader, remoteChunk]).arrayBuffer());
                  responseHeader = null;
                } else {
                  webSocket.send(remoteChunk);
                }
              } catch (err) {
                console.error(`[ERROR] Gagal mengirim balasan ke klien WebSocket: ${err.message}`);
              }
            }
          }
        })).catch((err) => {
          console.error(`[INFO/ERROR] Stream dari target ditutup/error: ${err.message}`);
        });
      }
    }
  })).catch((err) => {
    console.error(`[ERROR] Stream WebSocket utama bermasalah: ${err.message}`);
  });

  return new Response(null, { status: 101, webSocket: client });
}
