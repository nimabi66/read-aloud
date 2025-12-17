import logger from "../utils/logger";

export type IsomorphicMessageData = string | ArrayBuffer | Blob | Uint8Array;

export interface IsomorphicMessageEvent {
  data: IsomorphicMessageData;
}

export interface IsomorphicCloseEvent {
  code?: number;
  reason?: string;
}

export interface IsomorphicWebSocket {
  readonly readyState: number;
  addEventListener(type: "open", listener: (event: Event) => void): void;
  addEventListener(
    type: "message",
    listener: (event: IsomorphicMessageEvent) => void,
  ): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  addEventListener(
    type: "close",
    listener: (event: IsomorphicCloseEvent) => void,
  ): void;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void;
}

export interface IsomorphicWebSocketOptions {
  headers?: Record<string, string>;
}

export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export async function getIsomorphicWebSocket(
  url: string,
  options: IsomorphicWebSocketOptions = {},
): Promise<IsomorphicWebSocket> {
  if (isCloudflareWorkerRuntime()) {
    logger.debug({ url }, "Using Cloudflare Worker WebSocket implementation");
    return createCloudflareWebSocket(url, options);
  }

  if (isNodeRuntime()) {
    logger.debug({ url }, "Using Node WebSocket implementation");
    return createNodeWebSocket(url, options);
  }

  logger.warn(
    "Falling back to global WebSocket; custom headers may not be applied",
  );
  return createGlobalWebSocket(url);
}

function isNodeRuntime() {
  return typeof process !== "undefined" && process.release?.name === "node";
}

function isCloudflareWorkerRuntime() {
  return typeof WebSocketPair !== "undefined";
}

async function createNodeWebSocket(
  url: string,
  options: IsomorphicWebSocketOptions,
): Promise<IsomorphicWebSocket> {
  const { default: NodeWebSocket } = await import("ws");
  const socket = new NodeWebSocket(url, {
    headers: options.headers,
  });
  return wrapNodeWebSocket(socket);
}

function wrapNodeWebSocket(socket: import("ws").default): IsomorphicWebSocket {
  return {
    get readyState() {
      return socket.readyState;
    },
    addEventListener(type, listener) {
      // Prefer the native method if present (ws >= 8 supports it)
      if (typeof (socket as any)["addEventListener"] === "function") {
        (socket as any).addEventListener(type, listener);
        return;
      }

      switch (type) {
        case "open": {
          socket.on("open", () => {
            listener({} as any);
          });
          break;
        }
        case "message": {
          socket.on("message", (data) => {
            const normalized = normalizeNodeMessageData(data);
            (listener as (event: IsomorphicMessageEvent) => void)({
              data: normalized,
            });
          });
          break;
        }
        case "error": {
          socket.on("error", (error) => {
            listener(error as any);
          });
          break;
        }
        case "close": {
          socket.on("close", (code, reason) => {
            (listener as (event: IsomorphicCloseEvent) => void)({
              code,
              reason: reason?.toString(),
            });
          });
          break;
        }
      }
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    send(data) {
      socket.send(data as never);
    },
  };
}

function normalizeNodeMessageData(data: unknown): IsomorphicMessageData {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) {
    const chunks = data.map((chunk) => {
      if (chunk instanceof Uint8Array) {
        return chunk;
      }
      if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
      }
      if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
      return new Uint8Array();
    });
    const totalLength = chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array();
}

async function createCloudflareWebSocket(
  url: string,
  options: IsomorphicWebSocketOptions,
): Promise<IsomorphicWebSocket> {
  const response = await fetch(url.replace("wss://", "https://"), {
    headers: { ...options.headers, Upgrade: "websocket" },
  });
  if (response.webSocket === null) {
    throw new Error(
      `Server refused the WebSocket upgrade: ${response.status} ${response.statusText}`,
    );
  }

  const socket = response.webSocket;
  socket.accept();
  return socket;
}

function createGlobalWebSocket(url: string): IsomorphicWebSocket {
  // Custom headers are not supported in the standard WebSocket constructor.
  return new WebSocket(url);
}
