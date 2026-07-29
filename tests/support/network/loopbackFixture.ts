import { createServer as createHttpServer } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo, Server, Socket } from "node:net";

/** A listening server bound to an ephemeral IPv4 loopback port. */
export interface LoopbackEndpoint {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
}

/** Registry for loopback servers and accepted sockets owned by one test. */
export interface TestLoopback {
  listen(server: Server): Promise<LoopbackEndpoint>;
  http(listener: RequestListener): Promise<LoopbackEndpoint>;
  close(): Promise<void>;
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });

/** Create a loopback registry for a fixture composition root. */
export const createTestLoopback = (): TestLoopback => {
  const servers: Server[] = [];
  const sockets = new Set<Socket>();

  const listen = async (server: Server): Promise<LoopbackEndpoint> => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    return {
      host: "127.0.0.1",
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`,
    };
  };

  return {
    listen,
    http: (listener) => listen(createHttpServer(listener)),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      const results = await Promise.allSettled(
        [...servers].reverse().map(closeServer),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
};
