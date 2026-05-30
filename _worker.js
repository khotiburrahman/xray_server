import { connect } from "cloudflare:sockets";

let serviceName = "";
let APP_DOMAIN = "";
let prxIP = "";

const horse = "dHJvamFu";
const flash = "dm1lc3M=";
const neko = "dmxlc3M=";
const v2 = "djJyYXk=";

const PORTS = [443, 80];
const PROTOCOLS = [atob(horse), atob(flash), atob(neko), "ss"];
const SUB_PAGE_URL = "https://foolvpn.web.id/nautica";

// MASUKKAN URL RAW GITHUB ANDA DI SINI
const GITHUB_RAW_URL = "https://raw.githubusercontent.com/khotiburrahman/auto_proxy/refs/heads/main/active_proxies.txt";

const DNS_SERVER_ADDRESS = "174.138.21.128";
const DNS_SERVER_PORT = 53;
const RELAY_SERVER_UDP = { host: "udp-relay.hobihaus.space", port: 7300 };
const CONVERTER_URL = "https://api.foolvpn.web.id/convert";
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const SALT_A1 = atob("Vk1lc3MgSGVhZGVyIEFFQUQgS2V5X0xlbmd0aA==");
const SALT_A2 = atob("Vk1lc3MgSGVhZGVyIEFFQUQgTm9uY2VfTGVuZ3Ro");
const SALT_A3 = atob("Vk1lc3MgSGVhZGVyIEFFQUQgS2V5");
const SALT_A4 = atob("Vk1lc3MgSGVhZGVyIEFFQUQgTm9uY2U=");
const SALT_B1 = atob("QUVBRCBSZXNwIEhlYWRlciBMZW4gS2V5");
const SALT_B2 = atob("QUVBRCBSZXNwIEhlYWRlciBMZW4gSVY=");
const SALT_B3 = atob("QUVBRCBSZXNwIEhlYWRlciBLZXk=");
const SALT_B4 = atob("QUVBRCBSZXNwIEhlYWRlciBJVg==");

async function syncGitHubToKV(env) {
  if (!env.PROXY_DB) return { error: "PROXY_DB tidak ditemukan" };
  const req = await fetch(GITHUB_RAW_URL);
  if (req.status === 200) {
    const text = await req.text();
    const lines = text.split('\n').filter(Boolean);
    const proxies = lines.map(line => {
      const [prxIP, prxPort, country, org] = line.split(',');
      return { prxIP, prxPort, country, org };
    });
    await env.PROXY_DB.put("PROXIES_JSON", JSON.stringify(proxies));
    await env.PROXY_DB.put("HOMEPAGE_CACHE", text);
    return { status: "success", total: proxies.length };
  }
  return { error: "Gagal mengambil data dari GitHub" };
}

async function reverseWeb(request, target, targetPath) {
  const targetUrl = new URL(request.url);
  const targetChunk = target.split(":");
  targetUrl.hostname = targetChunk[0];
  targetUrl.port = targetChunk[1]?.toString() || "443";
  targetUrl.pathname = targetPath || targetUrl.pathname;
  const modifiedRequest = new Request(targetUrl, request);
  modifiedRequest.headers.set("X-Forwarded-Host", request.headers.get("Host"));
  const response = await fetch(modifiedRequest);
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADER_OPTIONS)) {
    newResponse.headers.set(key, value);
  }
  newResponse.headers.set("X-Proxied-By", "Cloudflare Worker");
  return newResponse;
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      APP_DOMAIN = url.hostname;
      serviceName = APP_DOMAIN.split(".")[0];
      
      // FIX 1: Mendukung HTTPUpgrade dan WebSocket
      const upgradeHeader = request.headers.get("Upgrade") || "";
      const isUpgrade = upgradeHeader.toLowerCase() === "websocket" || upgradeHeader.toLowerCase() === "httpupgrade";

      if (url.pathname === "/sync-db") {
        const result = await syncGitHubToKV(env);
        return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADER_OPTIONS } });
      }

      let cachedPrxList = [];
      if (env.PROXY_DB) cachedPrxList = await env.PROXY_DB.get("PROXIES_JSON", "json") || [];

      if (url.pathname === "/" && !isUpgrade) {
        const cache = await env.PROXY_DB?.get("HOMEPAGE_CACHE");
        return new Response(cache || "Data belum sinkron. Akses /sync-db terlebih dahulu.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADER_OPTIONS } });
      }

      if (isUpgrade) {
        const reqPath = url.pathname.replace(/^\/+/, '').toUpperCase();
        const ipPortMatch = url.pathname.match(/^\/(.+[:=-]\d+)$/);

        if (url.pathname.toLowerCase() === "/cf" || reqPath.startsWith("CF")) {
          prxIP = "1.1.1.1-443"; 
        } 
        else if (ipPortMatch && !/^[A-Z]+(\d*)$/.test(reqPath)) {
          prxIP = ipPortMatch[1];
        } 
        else if (cachedPrxList.length > 0) {
          let availableProxies = cachedPrxList;
          const ccMatch = reqPath.match(/^([A-Z]+)(\d*)$/);
          if (ccMatch) {
            const cc = ccMatch[1];
            const filtered = cachedPrxList.filter(p => p.country && p.country.toUpperCase() === cc);
            if (filtered.length > 0) {
              let idx = parseInt(ccMatch[2]);
              if (isNaN(idx)) availableProxies = [filtered[Math.floor(Math.random() * filtered.length)]];
              else availableProxies = [filtered[(idx - 1) % filtered.length] || filtered[0]];
            }
          }
          const randomPrx = availableProxies[0] || availableProxies[Math.floor(Math.random() * availableProxies.length)];
          prxIP = `${randomPrx.prxIP}-${randomPrx.prxPort}`;
        } else {
          prxIP = "1.1.1.1-443";
        }
        return await websocketHandler(request);
      }

      if (url.pathname.startsWith("/sub")) {
        return Response.redirect(SUB_PAGE_URL + `?host=${APP_DOMAIN}`, 301);
      } else if (url.pathname.startsWith("/api/v1/sub")) {
          const filterCC = url.searchParams.get("cc")?.split(",") || [];
          const filterPort = url.searchParams.get("port")?.split(",") || PORTS;
          const filterVPN = url.searchParams.get("vpn")?.split(",") || PROTOCOLS;
          const filterLimit = parseInt(url.searchParams.get("limit")) || 10;
          const fillerDomain = url.searchParams.get("domain") || APP_DOMAIN;

          let prxList = cachedPrxList;
          if (filterCC.length) prxList = prxList.filter((prx) => filterCC.includes(prx.country));
          
          let currentIndex = prxList.length;
          while (currentIndex != 0) {
            let randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [prxList[currentIndex], prxList[randomIndex]] = [prxList[randomIndex], prxList[currentIndex]];
          }

          const uuid = crypto.randomUUID();
          const result = [];
          for (const prx of prxList) {
            const countryTag = (prx.country || "UN").toUpperCase();
            
            // FIX: Generate WS dan HTTPUpgrade otomatis
            for (const port of filterPort) {
              for (const protocol of filterVPN) {
                if (result.length >= filterLimit * 2) break;
                
                const types = ["ws", "httpupgrade"];
                for (const transport of types) {
                  const uri = new URL(`${protocol}://${fillerDomain}`);
                  uri.searchParams.set("encryption", "none");
                  uri.searchParams.set("type", transport);
                  uri.searchParams.set("host", APP_DOMAIN);
                  uri.port = port.toString();
                  uri.username = uuid;
                  uri.searchParams.set("security", port == 443 ? "tls" : "none");
                  uri.searchParams.set("sni", port == 80 && protocol == atob(flash) ? "" : APP_DOMAIN);
                  
                  const targetPath = `/${countryTag.toLowerCase()}${prxList.indexOf(prx)+1}`;
                  uri.searchParams.set("path", targetPath);
                  
                  const tagType = transport === "ws" ? "WS" : "UPG";
                  uri.hash = `${prx.org.toUpperCase()} ${tagType} [${countryTag}-${prxList.indexOf(prx)+1}]`;
                  result.push(uri.toString());
                }
              }
            }
          }
          return new Response(result.join("\n"), { status: 200, headers: { ...CORS_HEADER_OPTIONS } });
      }

      const targetReversePrx = env.REVERSE_PRX_TARGET || "example.com";
      return await reverseWeb(request, targetReversePrx);
    } catch (err) {
      return new Response(`An error occurred: ${err.toString()}`, { status: 500, headers: { ...CORS_HEADER_OPTIONS } });
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(syncGitHubToKV(env)); }
};

async function websocketHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let addressLog = "";
  let portLog = "";
  const log = (info, event) => { console.log(`[${addressLog}:${portLog}] ${info}`, event || ""); };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWrapper = { value: null };
  let isDNS = false;

  // FIX 3: Penampung fragmentasi data dari Clash
  let headerBuffer = new ArrayBuffer(0);

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDNS) return handleUDPOutbound(DNS_SERVER_ADDRESS, DNS_SERVER_PORT, chunk, webSocket, null, log, RELAY_SERVER_UDP);
          
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          // Kumpulkan kepingan data yang dikirim bertahap oleh Clash
          const chunkArray = new Uint8Array(chunk);
          const newBuffer = new Uint8Array(headerBuffer.byteLength + chunkArray.byteLength);
          newBuffer.set(new Uint8Array(headerBuffer), 0);
          newBuffer.set(chunkArray, headerBuffer.byteLength);
          headerBuffer = newBuffer.buffer;

          const protocol = await protocolSniffer(headerBuffer);
          if (protocol === "wait") return; // Data Clash belum lengkap, tunggu kepingan berikutnya!

          let protocolHeader;
          try {
            if (protocol === atob(horse)) protocolHeader = readHorseHeader(headerBuffer);
            else if (protocol === atob(flash)) protocolHeader = await readStreamHeader(headerBuffer);
            else if (protocol === atob(neko)) protocolHeader = readNekoHeader(headerBuffer);
            else if (protocol === "ss") protocolHeader = readSsHeader(headerBuffer);
            else throw new Error("Unknown Protocol!");
          } catch (e) {
            if (e instanceof RangeError) return; // Data masih kurang, tunggu kepingan berikutnya
            throw e;
          }

          addressLog = protocolHeader.addressRemote;
          portLog = `${protocolHeader.portRemote} -> ${protocolHeader.isUDP ? "UDP" : "TCP"}`;

          if (protocolHeader.hasError) throw new Error(protocolHeader.message);

          let responseHeader = protocolHeader.version;
          if (protocol === atob(flash) && protocolHeader.needsResponse) {
            responseHeader = await generateStreamResponseHeader(protocolHeader.responseOptions, protocolHeader.encKey, protocolHeader.encIv);
          }

          if (protocolHeader.isUDP) {
            if (protocolHeader.portRemote === 53) {
              isDNS = true;
              return handleUDPOutbound(DNS_SERVER_ADDRESS, DNS_SERVER_PORT, chunk, webSocket, responseHeader, log, RELAY_SERVER_UDP);
            }
            return handleUDPOutbound(protocolHeader.addressRemote, protocolHeader.portRemote, chunk, webSocket, responseHeader, log, RELAY_SERVER_UDP);
          }

          handleTCPOutBound(remoteSocketWrapper, protocolHeader.addressRemote, protocolHeader.portRemote, protocolHeader.rawClientData, webSocket, responseHeader, log);
        },
        close() {}, abort(reason) {},
      }),
    ).catch((err) => {});

  return new Response(null, { status: 101, webSocket: client });
}

// FIX 2 & 3: Sniffer yang disempurnakan (Toleran terhadap VLESS murni & Menahan Ping Clash)
async function protocolSniffer(buffer) {
  const view = new Uint8Array(buffer);
  if (view.byteLength >= 1 && view[0] === 0x00) return atob(neko); // VLESS
  if (view.byteLength >= 58 && view[56] === 0x0d && view[57] === 0x0a) return atob(horse); // TROJAN
  if (view.byteLength >= 42) {
    const firstByte = view[0];
    if (firstByte === 0x01 || firstByte === 0x03 || firstByte === 0x04) return "ss";
    return atob(flash); // VMESS
  }
  if (view.byteLength < 58) return "wait"; // Tahan koneksi jika Clash baru mengirim sebagian password
  return "ss";
}

async function generateStreamResponseHeader(responseOptions, encKey, encIv) {
  try {
    const key = (await sha256(encKey)).slice(0, 16);
    const iv = (await sha256(encIv)).slice(0, 16);
    const lengthKey = (await kdf(key, [SALT_B1])).slice(0, 16);
    const lengthIv = (await kdf(iv, [SALT_B2])).slice(0, 12);
    const lengthData = new Uint8Array(2);
    lengthData[0] = 0; lengthData[1] = 4;
    const encryptedLength = await aesGcmEncrypt(lengthKey, lengthIv, lengthData, new Uint8Array(0));
    const headerPayload = new Uint8Array([responseOptions[0], 0x00, 0x00, 0x00]);
    const payloadKey = (await kdf(key, [SALT_B3])).slice(0, 16);
    const payloadIv = (await kdf(iv, [SALT_B4])).slice(0, 12);
    const encryptedPayload = await aesGcmEncrypt(payloadKey, payloadIv, headerPayload, new Uint8Array(0));
    const response = new Uint8Array(encryptedLength.length + encryptedPayload.length);
    response.set(encryptedLength, 0);
    response.set(encryptedPayload, encryptedLength.length);
    return response;
  } catch (e) { return new Uint8Array(0); }
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log) {
  async function connectAndWrite(address, port) {
    const tcpSocket = connect({ hostname: address, port: port });
    remoteSocket.value = tcpSocket;
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }
  async function retry() {
    const tcpSocket = await connectAndWrite(prxIP.split(/[:=-]/)[0] || addressRemote, prxIP.split(/[:=-]/)[1] || portRemote);
    tcpSocket.closed.catch(() => {}).finally(() => { safeCloseWebSocket(webSocket); });
    remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
}

async function handleUDPOutbound(targetAddress, targetPort, dataChunk, webSocket, responseHeader, log, relay) {
  try {
    let protocolHeader = responseHeader;
    const tcpSocket = connect({ hostname: relay.host, port: relay.port });
    const header = `udp:${targetAddress}:${targetPort}`;
    const headerBuffer = new TextEncoder().encode(header);
    const separator = new Uint8Array([0x7c]);
    const relayMessage = new Uint8Array(headerBuffer.length + separator.length + dataChunk.byteLength);
    relayMessage.set(headerBuffer, 0);
    relayMessage.set(separator, headerBuffer.length);
    relayMessage.set(new Uint8Array(dataChunk), headerBuffer.length + separator.length);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(relayMessage);
    writer.releaseLock();
    await tcpSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (protocolHeader) {
              webSocket.send(await new Blob([protocolHeader, chunk]).arrayBuffer());
              protocolHeader = null;
            } else webSocket.send(chunk);
          }
        },
        close() {}, abort(reason) {},
      }),
    );
  } catch (e) {}
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocketServer.addEventListener("close", () => {
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener("error", (err) => { controller.error(err); });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    pull(controller) {},
    cancel(reason) {
      if (readableStreamCancel) return;
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
}

async function md5(...inputs) {
  const combined = new Uint8Array(inputs.reduce((acc, input) => acc + input.length, 0));
  let offset = 0;
  for (const input of inputs) {
    combined.set(new Uint8Array(input), offset);
    offset += input.length;
  }
  return new Uint8Array(await crypto.subtle.digest("MD5", combined));
}

async function sha256(input) { return new Uint8Array(await crypto.subtle.digest("SHA-256", input)); }

async function kdf(key, path) {
  async function recursiveHash(keyBytes, innerHashFn) {
    return async (data) => {
      const ipad = new Uint8Array(64);
      const opad = new Uint8Array(64);
      ipad.set(keyBytes.slice(0, Math.min(64, keyBytes.length)));
      opad.set(keyBytes.slice(0, Math.min(64, keyBytes.length)));
      for (let i = 0; i < 64; i++) { ipad[i] ^= 0x36; opad[i] ^= 0x5c; }
      const innerData = new Uint8Array(ipad.length + data.length);
      innerData.set(ipad); innerData.set(data, ipad.length);
      const innerResult = await innerHashFn(innerData);
      const outerData = new Uint8Array(opad.length + innerResult.length);
      outerData.set(opad); outerData.set(innerResult, opad.length);
      return await innerHashFn(outerData);
    };
  }
  const sha256Hash = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  let currentHashFn = await recursiveHash(new TextEncoder().encode("VMess AEAD KDF"), sha256Hash);
  for (const salt of path) {
    const saltBytes = typeof salt === "string" ? new TextEncoder().encode(salt) : new Uint8Array(salt);
    currentHashFn = await recursiveHash(saltBytes, currentHashFn);
  }
  return await currentHashFn(key);
}

async function aesGcmDecrypt(key, nonce, data, aad) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, cryptoKey, data));
}

async function aesGcmEncrypt(key, nonce, data, aad) {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, cryptoKey, data));
}

async function readStreamHeader(buffer) {
  try {
    const uuidString = "00000000-0000-0000-0000-000000000000";
    const uuidBytes = new Uint8Array(uuidString.replace(/-/g, "").match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    const authKey = await md5(uuidBytes, new TextEncoder().encode(atob("YzQ4NjE5ZmUtOGYwMi00OWUwLWI5ZTktZWRmNzYzZTE3ZTIx")));
    const authId = new Uint8Array(buffer.slice(0, 16));
    const encryptedLength = new Uint8Array(buffer.slice(16, 34));
    const nonce = new Uint8Array(buffer.slice(34, 42));
    const lengthKey = (await kdf(authKey, [SALT_A1, authId, nonce])).slice(0, 16);
    const lengthIv = (await kdf(authKey, [SALT_A2, authId, nonce])).slice(0, 12);
    const lengthBytes = await aesGcmDecrypt(lengthKey, lengthIv, encryptedLength, authId);
    const headerLength = (lengthBytes[0] << 8) | lengthBytes[1];
    const encryptedHeader = new Uint8Array(buffer.slice(42, 42 + headerLength + 16));
    const payloadKey = (await kdf(authKey, [SALT_A3, authId, nonce])).slice(0, 16);
    const payloadIv = (await kdf(authKey, [SALT_A4, authId, nonce])).slice(0, 12);
    const headerPayload = await aesGcmDecrypt(payloadKey, payloadIv, encryptedHeader, authId);
    const view = new DataView(headerPayload.buffer);
    let offset = 0;
    const version = view.getUint8(offset); offset += 1;
    if (version !== 1) return { hasError: true };
    const encIv = new Uint8Array(headerPayload.slice(offset, offset + 16)); offset += 16;
    const encKey = new Uint8Array(headerPayload.slice(offset, offset + 16)); offset += 16;
    const options = new Uint8Array(headerPayload.slice(offset, offset + 4)); offset += 4;
    const cmd = view.getUint8(offset); offset += 1;
    const isUDP = cmd !== 0x01;
    const portRemote = view.getUint16(offset, false); offset += 2;
    const addressType = view.getUint8(offset); offset += 1;
    let addressRemote = "";
    switch (addressType) {
      case 1:
        addressRemote = `${view.getUint8(offset)}.${view.getUint8(offset + 1)}.${view.getUint8(offset + 2)}.${view.getUint8(offset + 3)}`;
        offset += 4; break;
      case 2:
      case 3:
        const domainLength = view.getUint8(offset); offset += 1;
        addressRemote = new TextDecoder().decode(headerPayload.slice(offset, offset + domainLength));
        offset += domainLength; break;
      case 4:
        const ipv6Parts = [];
        for (let i = 0; i < 8; i++) ipv6Parts.push(view.getUint16(offset + i * 2, false).toString(16));
        addressRemote = ipv6Parts.join(":"); offset += 16; break;
    }
    const rawDataIndex = 42 + headerLength + 16;
    return {
      hasError: false, addressRemote, addressType, portRemote, rawDataIndex, rawClientData: buffer.slice(rawDataIndex),
      version: new Uint8Array([options[0], 0]), isUDP, needsResponse: true, responseOptions: options, encKey: encKey, encIv: encIv,
    };
  } catch (e) { return { hasError: true }; }
}

function readSsHeader(ssBuffer) {
  if (ssBuffer.byteLength < 4) throw new RangeError();
  const view = new DataView(ssBuffer);
  const addressType = view.getUint8(0);
  let addressLength = 0, addressValueIndex = 1, addressValue = "";
  switch (addressType) {
    case 1: addressLength = 4; addressValue = new Uint8Array(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join("."); break;
    case 3: addressLength = new Uint8Array(ssBuffer.slice(addressValueIndex, addressValueIndex + 1))[0]; addressValueIndex += 1; addressValue = new TextDecoder().decode(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)); break;
    case 4:
      addressLength = 16; const dataView = new DataView(ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)); const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":"); break;
  }
  const portIndex = addressValueIndex + addressLength;
  if (ssBuffer.byteLength < portIndex + 2) throw new RangeError();
  const portRemote = new DataView(ssBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  return { hasError: false, addressRemote: addressValue, addressType: addressType, portRemote: portRemote, rawDataIndex: portIndex + 2, rawClientData: ssBuffer.slice(portIndex + 2), version: null, isUDP: portRemote == 53 };
}

function readNekoHeader(buffer) {
  if (buffer.byteLength < 18) throw new RangeError();
  const version = new Uint8Array(buffer.slice(0, 1));
  let isUDP = false;
  const optLength = new Uint8Array(buffer.slice(17, 18))[0];
  if (buffer.byteLength < 18 + optLength + 3) throw new RangeError();
  const cmd = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
  if (cmd === 2) isUDP = true;
  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0];
  let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = "";
  switch (addressType) {
    case 1: addressLength = 4; addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join("."); break;
    case 2: 
      if (buffer.byteLength < addressValueIndex + 1) throw new RangeError();
      addressLength = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 1))[0]; 
      addressValueIndex += 1; 
      addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength)); break;
    case 3:
      addressLength = 16; const dataView = new DataView(buffer.slice(addressValueIndex, addressValueIndex + addressLength)); const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":"); break;
  }
  if (buffer.byteLength < addressValueIndex + addressLength) throw new RangeError();
  return { hasError: false, addressRemote: addressValue, addressType: addressType, portRemote: portRemote, rawDataIndex: addressValueIndex + addressLength, rawClientData: buffer.slice(addressValueIndex + addressLength), version: new Uint8Array([version[0], 0]), isUDP: isUDP };
}

function readHorseHeader(buffer) {
  if (buffer.byteLength < 60) throw new RangeError();
  const dataBuffer = buffer.slice(58);
  let isUDP = false;
  const view = new DataView(dataBuffer);
  const cmd = view.getUint8(0);
  if (cmd == 3) isUDP = true;
  let addressType = view.getUint8(1), addressLength = 0, addressValueIndex = 2, addressValue = "";
  switch (addressType) {
    case 1: addressLength = 4; addressValue = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join("."); break;
    case 3: addressLength = new Uint8Array(dataBuffer.slice(addressValueIndex, addressValueIndex + 1))[0]; addressValueIndex += 1; addressValue = new TextDecoder().decode(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)); break;
    case 4:
      addressLength = 16; const dataView = new DataView(dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)); const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":"); break;
  }
  const portIndex = addressValueIndex + addressLength;
  if (dataBuffer.byteLength < portIndex + 2) throw new RangeError();
  const portRemote = new DataView(dataBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  return { hasError: false, addressRemote: addressValue, addressType: addressType, portRemote: portRemote, rawDataIndex: portIndex + 4, rawClientData: dataBuffer.slice(portIndex + 4), version: null, isUDP: isUDP };
}

async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log) {
  let header = responseHeader;
  let hasIncomingData = false;
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          hasIncomingData = true;
          if (webSocket.readyState !== WS_READY_STATE_OPEN) return;
          if (header) { webSocket.send(await new Blob([header, chunk]).arrayBuffer()); header = null; } 
          else webSocket.send(chunk);
        },
        close() {}, abort(reason) {},
      }),
    )
    .catch(() => { safeCloseWebSocket(webSocket); });
  if (hasIncomingData === false && retry) { retry(); }
}

function safeCloseWebSocket(socket) {
  try { if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) socket.close(); } catch (error) {}
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
    const decode = atob(base64Str);
    return { earlyData: Uint8Array.from(decode, (c) => c.charCodeAt(0)).buffer, error: null };
  } catch (error) { return { error }; }
}

function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
