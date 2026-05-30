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
      // Normalisasi chunk ke Uint8Array murni
      let view;
      if (chunk instanceof Uint8Array) {
        view = chunk;
      } else if (chunk instanceof ArrayBuffer) {
        view = new Uint8Array(chunk);
      } else if (typeof chunk === "string") {
        view = new TextEncoder().encode(chunk);
      } else if (chunk && typeof chunk.arrayBuffer === "function") {
        view = new Uint8Array(await chunk.arrayBuffer());
      } else {
        view = new Uint8Array(chunk);
      }

      if (remoteSocketWrapper.value) {
        const writer = remoteSocketWrapper.value.writable.getWriter();
        await writer.write(view);
        writer.releaseLock();
        return;
      }

      const protocol = protocolSniffer(view);
      let headerData;

      if (protocol === "trojan") headerData = readHorseHeader(view);
      else headerData = readNekoHeader(view);

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

function protocolSniffer(view) {
  if (view.length >= 58 && view[56] === 0x0d && view[57] === 0x0a) return "trojan";
  return "vless"; // Fallback ke vless
}

function readNekoHeader(view) {
  try {
    if (view.length < 18) return { hasError: true };
    
    const version = view[0];
    const optLength = view[17];
    const portIndex = 18 + optLength + 1; 
    
    if (view.length < portIndex + 2) return { hasError: true };
    // Membaca port tanpa DataView (Bitwise)
    const portRemote = (view[portIndex] << 8) | view[portIndex + 1];
    
    let addressIndex = portIndex + 2;
    const addressType = view[addressIndex];
    let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = "";

    switch (addressType) {
      case 1: // IPv4
        addressLength = 4;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = view.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 2: // Domain
        addressLength = view[addressValueIndex];
        addressValueIndex += 1;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = new TextDecoder().decode(view.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3: // IPv6
        addressLength = 16;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          const hex = ((view[addressValueIndex + i * 2] << 8) | view[addressValueIndex + i * 2 + 1]).toString(16);
          ipv6.push(hex);
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
      rawClientData: view.slice(addressValueIndex + addressLength),
      version: new Uint8Array([version, 0])
    };
  } catch (e) {
    return { hasError: true };
  }
}

function readHorseHeader(viewAll) {
  try {
    if (viewAll.length < 58) return { hasError: true };
    const view = viewAll.slice(58);
    if (view.length < 4) return { hasError: true };
    
    let addressType = view[1];
    let addressLength = 0, addressValueIndex = 2, addressValue = "";

    switch (addressType) {
      case 1: // IPv4
        addressLength = 4;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = view.slice(addressValueIndex, addressValueIndex + addressLength).join(".");
        break;
      case 3: // Domain
        addressLength = view[addressValueIndex];
        addressValueIndex += 1;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        addressValue = new TextDecoder().decode(view.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4: // IPv6
        addressLength = 16;
        if (view.length < addressValueIndex + addressLength) return { hasError: true };
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
          const hex = ((view[addressValueIndex + i * 2] << 8) | view[addressValueIndex + i * 2 + 1]).toString(16);
          ipv6.push(hex);
        }
        addressValue = ipv6.join(":");
        break;
      default:
        return { hasError: true };
    }

    const portIndex = addressValueIndex + addressLength;
    if (view.length < portIndex + 2) return { hasError: true };
    const portRemote = (view[portIndex] << 8) | view[portIndex + 1];
    
    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: view.slice(portIndex + 4), // Melewati port & \r\n
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
      write(chunk) { // Sinkron, sangat cepat untuk membalas ke WS
        if (webSocket.readyState === 1) { 
          if (header) {
            const chunkView = new Uint8Array(chunk);
            const combined = new Uint8Array(header.length + chunkView.length);
            combined.set(header, 0);
            combined.set(chunkView, header.length);
            webSocket.send(combined);
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
          const parts = earlyDataHeader.split(",");
          const base64Str = (parts.length > 1 ? parts[1].trim() : parts[0].trim()).replace(/-/g, "+").replace(/_/g, "/");
          const decode = atob(base64Str);
          controller.enqueue(Uint8Array.from(decode, (c) => c.charCodeAt(0)));
        } catch (e) {}
      }
    },
    cancel() {
      readableStreamCancel = true;
      if (webSocketServer.readyState === 1) webSocketServer.close();
    }
  });
}
