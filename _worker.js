import { connect } from "cloudflare:sockets";

export default {
  async fetch(request) {
    try {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader === "websocket") {
        return await websocketHandler(request);
      }
      return new Response("Worker VLESS & Trojan Direct Aktif.", { status: 200 });
    } catch (err) {
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
      // 1. NORMALISASI CHUNK
      // Memastikan chunk selalu menjadi ArrayBuffer untuk mencegah error DataView
      let buffer;
      if (chunk instanceof ArrayBuffer) {
        buffer = chunk;
      } else if (chunk instanceof Uint8Array) {
        buffer = chunk.buffer;
      } else if (typeof chunk === "string") {
        buffer = new TextEncoder().encode(chunk).buffer;
      } else if (chunk && typeof chunk.arrayBuffer === "function") {
        buffer = await chunk.arrayBuffer(); // Handle Blob
      } else {
        buffer = new Uint8Array(chunk).buffer;
      }

      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(buffer);
        writer.releaseLock();
        return;
      }

      const protocol = protocolSniffer(buffer);
      let headerData;

      if (protocol === "trojan") headerData = readHorseHeader(buffer);
      else headerData = readNekoHeader(buffer);

      if (headerData.hasError || !headerData.addressRemote) {
        webSocket.close();
        return;
      }

      await handleTCPOutBound(
        remoteSocketWrapper,
        headerData.addressRemote,
        headerData.portRemote,
        headerData.rawClientData,
        webSocket,
        headerData.version
      );
    },
    close() {},
    abort() {},
  })).catch(() => {});

  return new Response(null, { status: 101, webSocket: client });
}

function protocolSniffer(buffer) {
  if (buffer.byteLength < 1) return "vless";
  const view = new Uint8Array(buffer);
  if (view[0] === 0) return "vless";
  if (buffer.byteLength >= 58 && view[56] === 0x0d && view[57] === 0x0a) return "trojan";
  return "vless";
}

function readNekoHeader(buffer) {
  try {
    if (buffer.byteLength < 18) return { hasError: true }; // Cek batas aman ukuran VLESS
    
    const viewUint8 = new Uint8Array(buffer);
    const version = viewUint8[0];
    const optLength = viewUint8[17];
    const portIndex = 18 + optLength + 1; 
    
    if (buffer.byteLength < portIndex + 2) return { hasError: true };
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
    return { hasError: true };
  }
}

function readHorseHeader(buffer) {
  try {
    if (buffer.byteLength < 58) return { hasError: true }; // Cek batas aman ukuran Trojan
    const dataBuffer = buffer.slice(58);
    if (dataBuffer.byteLength < 4) return { hasError: true };
    
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
        return { hasError: true };
    }

    const portIndex = addressValueIndex + addressLength;
    if (dataBuffer.byteLength < portIndex + 2) return { hasError: true };
    const portRemote = dataView.getUint16(portIndex, false);
    
    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: dataBuffer.slice(portIndex + 4),
      version: null
    };
  } catch (e) {
    return { hasError: true };
  }
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader) {
  try {
    const tcpSocket = connect({ hostname: addressRemote, port: portRemote });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();

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
    })).catch(() => {
      if (webSocket.readyState === 1) webSocket.close();
    });
  } catch (e) {
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
      webSocketServer.addEventListener("error", (err) => controller.error(err));

      if (earlyDataHeader) {
        try {
          // Penyesuaian decode jika earlyData dikirim berdampingan dengan nama protokol
          const parts = earlyDataHeader.split(",");
          const base64Str = (parts.length > 1 ? parts[1].trim() : parts[0].trim()).replace(/-/g, "+").replace(/_/g, "/");
          const decode = atob(base64Str);
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
