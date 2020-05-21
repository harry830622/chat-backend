import {
  listenAndServe,
  ServerRequest,
} from "https://deno.land/std/http/mod.ts";
import {
  acceptable,
  acceptWebSocket,
  isWebSocketPongEvent,
  isWebSocketCloseEvent,
  WebSocket,
  WebSocketEvent,
} from "https://deno.land/std/ws/mod.ts";
import { v4 as uuidv4 } from "https://deno.land/std/uuid/mod.ts";

const port = parseInt(Deno.env.get("PORT") || "3000");

interface User {
  name?: string;
  genderKey: string;
  filter: {
    genderKey: string;
  };
}

interface Evt {
  id: string;
  senderSockId?: string;
  receiverSockId?: string;
  type: string;
  payload: any;
}

const sockById = new Map<string, WebSocket>();

const userBySockId = new Map<string, User>();

const waitingSockIdsByGenderKey = new Map<string, Set<string>>([
  ["M", new Set<string>()],
  ["F", new Set<string>()],
]);

const pairedSockIdBySockId = new Map<string, string>();

const acceptSock: (req: ServerRequest) => Promise<string | null> = async (
  req,
) => {
  try {
    const sock = await acceptWebSocket({
      conn: req.conn,
      bufReader: req.r,
      bufWriter: req.w,
      headers: req.headers,
    });
    console.log("Connected");
    const sockId = uuidv4.generate();
    sockById.set(sockId, sock);
    return sockId;
  } catch (err) {
    console.error(`Failed to accept the socket: ${err}`);
    return null;
  }
};

const closeSock: (sockId: string) => Promise<void> = async (sockId) => {
  try {
    const sock = sockById.get(sockId);
    if (sock === undefined) {
      throw new Error(`No sock with id: ${sockId}`);
    }
    const pairedSockId = pairedSockIdBySockId.get(sockId);
    if (!sock.isClosed) {
      await sock.close();
      sockById.delete(sockId);
      userBySockId.delete(sockId);
      for (let [, sockIds] of waitingSockIdsByGenderKey) {
        sockIds.delete(sockId);
      }
      pairedSockIdBySockId.delete(sockId);
    }
    if (pairedSockId === undefined) {
      return;
    }
    const pairedSock = sockById.get(pairedSockId);
    if (pairedSock === undefined) {
      throw new Error(`No sock with id: ${sockId}`);
    }
    if (!pairedSock.isClosed) {
      await pairedSock.close();
      sockById.delete(pairedSockId);
      userBySockId.delete(pairedSockId);
      for (let [, sockIds] of waitingSockIdsByGenderKey) {
        sockIds.delete(pairedSockId);
      }
      pairedSockIdBySockId.delete(pairedSockId);
    }
  } catch (err) {
    console.error(`Failed to close the socket: ${err}`);
  }
};

const readEvt: (
  sockId: string,
  cb: (evt: WebSocketEvent) => Promise<void>,
) => Promise<void> = async (
  sockId,
  cb,
) => {
  try {
    const sock = sockById.get(sockId);
    if (sock === undefined) {
      throw new Error(`No sock with id: ${sockId}`);
    }
    for await (let evt of sock) {
      console.log(evt);
      await cb(evt);
    }
  } catch (err) {
    console.error(`Failed to read the event: ${err}`);
    await closeSock(sockId);
  }
};

const sendEvt: (sockId: string, evt: Evt) => Promise<void> = async (
  sockId,
  evt,
) => {
  try {
    const sock = sockById.get(sockId);
    if (sock === undefined) {
      throw new Error(`No sock with id: ${sockId}`);
    }
    await sock.send(JSON.stringify({
      ...evt,
      id: uuidv4.generate(),
    }));
  } catch (err) {
    console.error(`Failed to send the event: ${err}`);
  }
};

const pairUser: (user: User, sockId: string) => string | null = (
  user,
  sockId,
) => {
  const targetGenderKey = user.filter.genderKey === "A"
    ? (() => {
      if (
        waitingSockIdsByGenderKey.get(
          "M",
        )!.size === 0
      ) {
        return "F";
      }
      if (
        waitingSockIdsByGenderKey.get(
          "F",
        )!.size === 0
      ) {
        return "M";
      }
      return Math.random() < 0.5 ? "M" : "F";
    })()
    : user.filter.genderKey;
  const waitingSockIds = waitingSockIdsByGenderKey.get(
    targetGenderKey,
  );
  let pairedSockId: string | null = null;
  for (let id of waitingSockIds!) {
    const waitingUser = userBySockId.get(id);
    if (
      waitingUser!.filter.genderKey === "A" ||
      user.genderKey === waitingUser!.filter.genderKey
    ) {
      pairedSockId = id;
      break;
    }
  }
  if (pairedSockId !== null) {
    waitingSockIds!.delete(pairedSockId);
    pairedSockIdBySockId.set(sockId, pairedSockId);
    pairedSockIdBySockId.set(pairedSockId, sockId);
  }
  return pairedSockId;
};

listenAndServe({ port }, async (req) => {
  if (req.method === "GET" && acceptable(req)) {
    const sockId = await acceptSock(req);
    if (sockId === null) {
      await req.respond({ status: 400 });
      return;
    }
    const sock = sockById.get(sockId);
    let prevTimeoutId: number | null = null;
    let pongTimeoutId: number | null = null;
    await readEvt(sockId, async (evt) => {
      if (prevTimeoutId !== null) {
        clearTimeout(prevTimeoutId);
      }
      prevTimeoutId = setTimeout(() => {
        if (!sock!.isClosed) {
          sock!.ping();
          pongTimeoutId = setTimeout(() => {
            clearTimeout(prevTimeoutId!);
            closeSock(sockId);
          }, 3000);
        }
      }, 3000);
      if (typeof evt === "string") {
        const event = JSON.parse(evt);
        switch (event.type) {
          case "PAIR": {
            const { user } = event.payload;
            userBySockId.set(sockId, user);
            const pairedSockId = pairUser(user, sockId);
            if (pairedSockId !== null) {
              const pairedUser = userBySockId.get(pairedSockId);
              await sendEvt(sockId, {
                id: uuidv4.generate(),
                type: "PAIRED",
                payload: {
                  mySockId: sockId,
                  pairedUser: pairedUser!,
                  pairedSockId,
                },
              });
              await sendEvt(pairedSockId, {
                id: uuidv4.generate(),
                type: "PAIRED",
                payload: {
                  mySockId: pairedSockId,
                  pairedUser: user,
                  pairedSockId: sockId,
                },
              });
            } else {
              waitingSockIdsByGenderKey.get(user.genderKey)!.add(sockId);
            }
            break;
          }
          case "SEND": {
            const { message } = event.payload;
            switch (message.type) {
              case "TEXT": {
                await sendEvt(event.receiverSockId, {
                  id: uuidv4.generate(),
                  senderSockId: event.senderSockId,
                  receiverSockId: event.receiverSockId,
                  type: "RECEIVED",
                  payload: {
                    message: {
                      type: "TEXT",
                      payload: {
                        text: message.payload.text,
                      },
                    },
                  },
                });
                break;
              }
              default: {
                break;
              }
            }
            break;
          }
          default: {
            break;
          }
        }
      } else if (isWebSocketPongEvent(evt)) {
        clearTimeout(pongTimeoutId!);
      } else if (isWebSocketCloseEvent(evt)) {
        console.log("Disconnected");
        await closeSock(sockId);
      }
    });
  }
});
