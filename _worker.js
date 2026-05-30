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
      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const protocol = protocolSniffer(chunk);
      let headerData;

      if (protocol === "trojan") headerData = readHorseHeader(chunk);
      else headerData = readNekoHeader(chunk);

      if (headerData.hasError || !headerData.addressRemote) {
        webSocket.close();
        return;
      }

      handleTCPOutBound(
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
  const view = new Uint8Array(buffer);
  // VLESS selalu diawali dengan byte 0 (versi)
  if (view[0] === 0) return "vless";
  // Trojan selalu memiliki \r\n di index 56-57 setelah hash password
  if (buffer.byteLength >= 56 && view[56] === 0x0d && view[57] === 0x0a) return "trojan";
  return "vless";
}

function readNekoHeader(buffer) {
  try {
    const viewUint8 = new Uint8Array(buffer);
    const version = viewUint8[0];
    const optLength = viewUint8[17];
    const portIndex = 18 + optLength + 1; // Melewati byte command
    
    const dataView = new DataView(buffer);
    const portRemote = dataView.getUint16(portIndex, false);
    
    let addressIndex = portIndex + 2;
    const addressType = viewUint8[addressIndex];
    let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = "";

    switch (addressType) {
      case 1: // IPv4
        addressLength = 4;
        addressValue = viewUint8.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 2: // Domain
        addressLength = viewUint8[addressValueIndex];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3: // IPv6
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
    const dataBuffer = buffer.slice(58); // Melewati password (56) + \r\n (2)
    const viewUint8 = new Uint8Array(dataBuffer);
    const dataView = new DataView(dataBuffer);
    
    let addressType = viewUint8[1];
    let addressLength = 0, addressValueIndex = 2, addressValue = "";

    switch (addressType) {
      case 1: // IPv4
        addressLength = 4;
        addressValue = viewUint8.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 3: // Domain
        addressLength = viewUint8[addressValueIndex];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4: // IPv6
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
    const portRemote = dataView.getUint16(portIndex, false);
    
    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: dataBuffer.slice(portIndex + 4), // Melewati port (2) + \r\n (2)
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
