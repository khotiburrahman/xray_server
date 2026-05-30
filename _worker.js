import { connect } from "cloudflare:sockets";

export default {
  async fetch(request) {
    try {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader === "websocket") {
        return await websocketHandler(request);
      }
      return new Response("Worker VLESS & Trojan Direct (Tanpa Proxy) Aktif.", { status: 200 });
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

      if (headerData.hasError) throw new Error("Header invalid");

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
  if (buffer.byteLength >= 56) {
    const delim = new Uint8Array(buffer.slice(56, 60));
    if (delim[0] === 0x0d && delim[1] === 0x0a) return "trojan";
  }
  return "vless";
}

function readNekoHeader(buffer) {
  try {
    const version = new Uint8Array(buffer.slice(0, 1));
    const optLength = new Uint8Array(buffer.slice(17, 18))[0];
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressType = buffer[addressIndex];
    let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 2:
        addressLength = buffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 3:
        addressLength = 16;
        const dataView = new DataView(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
        const ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
        addressValue = ipv6.join(":");
        break;
    }
    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawClientData: buffer.slice(addressValueIndex + addressLength),
      version: new Uint8Array([version[0], 0])
    };
  } catch (e) {
    return { hasError: true };
  }
}

function readHorseHeader(buffer) {
  try {
    const dataBuffer = buffer.slice(58);
    const view = new DataView(dataBuffer);
    let addressType = view.getUint8(1), addressLength = 0, addressValueIndex = 2, addressValue = "";

    switch (addressType) {
      case 1:
        addressLength = 4;
        addressValue = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
        break;
      case 3:
        addressLength = dataBuffer[addressValueIndex];
        addressValueIndex += 1;
        addressValue = new TextDecoder().decode(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        break;
      case 4:
        addressLength = 16;
        const dataView = new DataView(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
        const ipv6 = [];
        for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
        addressValue = ipv6.join(":");
        break;
    }
    const portIndex = addressValueIndex + addressLength;
    const portRemote = new DataView(dataBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
    
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
        if (webSocket.readyState === 1) { // WS_READY_STATE_OPEN
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
