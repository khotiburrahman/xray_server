import { connect } from "cloudflare:sockets";

export default {
  async fetch(request) {
    try {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader === "websocket") {
        console.log("[DEBUG] Menerima koneksi WebSocket baru");
        return await websocketHandler(request);
      }
      return new Response("Worker VLESS & Trojan Direct Aktif.", { status: 200 });
    } catch (err) {
      console.log("[ERROR] Fetch error:", err.toString());
      return new Response(`Error: ${err.toString()}`, { status: 500 });
    }
  }
};

async function websocketHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let remoteSocketWrapper = { value: null };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      console.log(`[DEBUG] Chunk diterima, ukuran: ${chunk.byteLength} bytes`);
      const protocol = protocolSniffer(chunk);
      console.log(`[DEBUG] Protokol terdeteksi: ${protocol}`);
      
      let headerData;
      if (protocol === "trojan") headerData = readHorseHeader(chunk);
      else headerData = readNekoHeader(chunk);

      if (headerData.hasError) {
        console.log("[ERROR] Gagal membaca header/payload VPN.");
        webSocket.close();
        return;
      }
      
      if (!headerData.addressRemote) {
        console.log("[ERROR] Alamat tujuan kosong/gagal diekstrak.");
        webSocket.close();
        return;
      }

      console.log(`[DEBUG] Ekstraksi Sukses -> Tujuan: ${headerData.addressRemote}:${headerData.portRemote}`);

      await handleTCPOutBound(
        remoteSocketWrapper,
        headerData.addressRemote,
        headerData.portRemote,
        headerData.rawClientData,
        webSocket,
        headerData.version
      );
    },
    close() {
        console.log("[DEBUG] WebSocket dari client ditutup.");
    },
    abort(err) {
        console.log("[ERROR] WebSocket abort:", err);
    },
  })).catch((err) => {
      console.log("[ERROR] Pipe stream error:", err);
  });

  return new Response(null, { status: 101, webSocket: client });
}

function protocolSniffer(buffer) {
  const view = new Uint8Array(buffer);
  if (view[0] === 0) return "vless";
  if (buffer.byteLength >= 56 && view[56] === 0x0d && view[57] === 0x0a) return "trojan";
  return "vless";
}

function readNekoHeader(buffer) {
  try {
    const viewUint8 = new Uint8Array(buffer);
    const version = viewUint8[0];
    const optLength = viewUint8[17];
    const portIndex = 18 + optLength + 1; 
    
    const dataView = new DataView(buffer);
    const portRemote = dataView.getUint16(portIndex, false);
    
    let addressIndex = portIndex + 2;
    const addressType = viewUint8[addressIndex];
    let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = viewUint8.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 2:
        addressLength = viewUint8[addressValueIndex];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(addressValueIndex + i * 2, false).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
        console.log(`[ERROR] VLESS AddressType tidak dikenal: ${addressType}`);
        return { hasError: true };
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: buffer.slice(addressValueIndex + addressLength),
      version: new Uint8Array([version, 0])
    };
  } catch (e) {
    console.log("[ERROR] Exception VLESS Header:", e.message);
    return { hasError: true };
  }
}

function readHorseHeader(buffer) {
  try {
    const dataBuffer = buffer.slice(58);
    const viewUint8 = new Uint8Array(dataBuffer);
    const dataView = new DataView(dataBuffer);
    
    let addressType = viewUint8[1];
    let addressLength = 0, addressValueIndex = 2, addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = viewUint8.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 3:
        addressLength = viewUint8[addressValueIndex];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4:
        addressLength = 16;
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          ipv6.push(dataView.getUint16(addressValueIndex + i * 2, false).toString(16));
        }
        addressValue = ipv6.join(":");
        break;
      default:
         console.log(`[ERROR] Trojan AddressType tidak dikenal: ${addressType}`);
        return { hasError: true };
    }

    const portIndex = addressValueIndex + addressLength;
    const portRemote = dataView.getUint16(portIndex, false);
    
    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: dataBuffer.slice(portIndex + 4),
      version: null
    };
  } catch (e) {
    console.log("[ERROR] Exception Trojan Header:", e.message);
    return { hasError: true };
  }
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader) {
  try {
    console.log(`[DEBUG] Mencoba TCP connect ke -> ${addressRemote}:${portRemote}`);
    const tcpSocket = connect({ hostname: addressRemote, port: portRemote });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    console.log(`[DEBUG] Berhasil mengirim payload ke ${addressRemote}`);

    let header = responseHeader;
    tcpSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (webSocket.readyState === 1) { 
          if (header) {
            webSocket.send(await new Blob([header, chunk]).arrayBuffer());
            header = null;
          } else {
            webSocket.send(chunk);
          }
        }
      }
    })).catch((err) => {
      console.log(`[ERROR] Koneksi TCP terputus dari ${addressRemote}`);
      if (webSocket.readyState === 1) webSocket.close();
    });
  } catch (e) {
    console.log(`[ERROR] Gagal connect TCP ke ${addressRemote}`);
    if (webSocket.readyState === 1) webSocket.close();
  }
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocketServer.addEventListener("close", () => {
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener("error", (err) => {
          console.log("[ERROR] WebSocket server error:", err);
          controller.error(err);
      });

      if (earlyDataHeader) {
        try {
          const decode = atob(earlyDataHeader.replace(/-/g, "+").replace(/_/g, "/"));
          controller.enqueue(Uint8Array.from(decode, (c) => c.charCodeAt(0)).buffer);
        } catch (e) {}
      }
    },
    cancel() {
      readableStreamCancel = true;
      if (webSocketServer.readyState === 1) webSocketServer.close();
    }
  });
}
