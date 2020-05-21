import { listenAndServe } from "https://deno.land/std/http/mod.ts";
import {
  acceptable,
  acceptWebSocket,
  isWebSocketCloseEvent,
  WebSocket,
} from "https://deno.land/std/ws/mod.ts";
import { v4 as uuidv4 } from "https://deno.land/std/uuid/mod.ts";

const port = parseInt(Deno.env.get("PORT") || "8080");

interface User {
  name?: string;
  genderKey: string;
  filter: {
    genderKey: string;
  };
}

const userById = new Map<string, User>();

const sockByUserId = new Map<string, WebSocket>();

const waitingUserIdsByGenderKey = new Map<string, Array<string>>([
  ["M", []],
  ["F", []],
]);

listenAndServe({ port }, async (req) => {
  if (req.method === "GET" && acceptable(req)) {
    try {
      const sock = await acceptWebSocket({
        conn: req.conn,
        bufReader: req.r,
        bufWriter: req.w,
        headers: req.headers,
      });
      console.log("Connected");
      try {
        for await (let evt of sock) {
          console.log(evt);
          if (typeof evt === "string") {
            const event = JSON.parse(evt);
            switch (event.type) {
              case "PAIR": {
                const { user } = event.payload;
                const newUserId = uuidv4.generate();
                userById.set(newUserId, user);
                sockByUserId.set(newUserId, sock);
                const filterGenderKey = user.filter.genderKey === "A"
                  ? (() => {
                    if (
                      waitingUserIdsByGenderKey.get(
                        "M",
                      )!.length === 0
                    ) {
                      return "F";
                    }
                    if (
                      waitingUserIdsByGenderKey.get(
                        "F",
                      )!.length === 0
                    ) {
                      return "M";
                    }
                    return Math.random() < 0.5 ? "M" : "F";
                  })()
                  : user.filter.genderKey;
                const waitingUserIds = waitingUserIdsByGenderKey.get(
                  filterGenderKey,
                );
                const pairedUserId = waitingUserIds!.find((id) => {
                  const waitingUser = userById.get(id);
                  if (waitingUser!.filter.genderKey === "A") {
                    return true;
                  }
                  return user.genderKey === waitingUser!.filter.genderKey;
                });
                if (pairedUserId) {
                  waitingUserIds!.splice(
                    waitingUserIds!.findIndex((id) => id === pairedUserId),
                    1,
                  );
                  const pairedUser = userById.get(pairedUserId);
                  sock.send(JSON.stringify({
                    id: uuidv4.generate(),
                    type: "PAIRED",
                    payload: {
                      myId: newUserId,
                      paired: {
                        ...pairedUser!,
                        id: pairedUserId,
                      },
                    },
                  }));
                  const pairedSock = sockByUserId.get(pairedUserId);
                  pairedSock!.send(JSON.stringify({
                    id: uuidv4.generate(),
                    type: "PAIRED",
                    payload: {
                      myId: pairedUserId,
                      paired: {
                        ...user,
                        id: newUserId,
                      },
                    },
                  }));
                } else {
                  waitingUserIdsByGenderKey.get(
                    user.genderKey,
                  )!.push(newUserId);
                }
                break;
              }
              case "SEND": {
                const { message } = event.payload;
                switch (message.type) {
                  case "TEXT": {
                    const receiverSock = sockByUserId.get(event.receiverId);
                    receiverSock!.send(JSON.stringify({
                      id: uuidv4.generate(),
                      type: "RECEIVED",
                      senderId: event.senderId,
                      receiverId: event.receiverId,
                      payload: {
                        message: {
                          type: "TEXT",
                          payload: {
                            text: message.payload.text,
                          },
                        },
                      },
                    }));
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
          } else if (isWebSocketCloseEvent(evt)) {
            console.log("Disconnected");
          }
        }
      } catch (err) {
        console.error(`Failed to receive frames: ${err}`);
        await sock.close();
      }
    } catch (err) {
      console.error(`Failed to accept web socket: ${err}`);
      await req.respond({ status: 400 });
    }
  }
});
