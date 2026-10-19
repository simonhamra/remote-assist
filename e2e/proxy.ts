import { WebSocket, WebSocketServer } from 'ws';

type Message = Record<string, unknown> & { t: string };

export interface ProxiedConnection {
  /** From the device's sign-in message. */
  role: 'host' | 'helper' | null;
  /** Every message the device sent. */
  sent: Message[];
  /** Sends a message to the server on the device's behalf (it is signed in already). */
  injectUpstream(message: Message): void;
}

type Rule = (message: Message, connection: ProxiedConnection) => Message | void;

/**
 * Sits between the apps and the signaling server and can rewrite or replay what passes: a
 * stand-in for a compromised server or network. Rules run in order on every JSON message.
 */
export async function startTamperingProxy(upstream: string) {
  const toClient: Rule[] = [];
  const toServer: Rule[] = [];
  const connections: ProxiedConnection[] = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));

  wss.on('connection', (client) => {
    const server = new WebSocket(upstream);
    const queued: string[] = [];
    const sendUpstream = (text: string) =>
      server.readyState === WebSocket.OPEN ? server.send(text) : queued.push(text);
    const connection: ProxiedConnection = {
      role: null,
      sent: [],
      injectUpstream: (message) => sendUpstream(JSON.stringify(message)),
    };
    connections.push(connection);

    server.on('open', () => queued.splice(0).forEach((text) => server.send(text)));
    client.on('message', (data) => {
      let message = JSON.parse(String(data)) as Message;
      if (message.t === 'auth') connection.role = message.role as 'host' | 'helper';
      connection.sent.push(message);
      for (const rule of toServer) message = rule(message, connection) ?? message;
      sendUpstream(JSON.stringify(message));
    });
    server.on('message', (data) => {
      let message = JSON.parse(String(data)) as Message;
      for (const rule of toClient) message = rule(message, connection) ?? message;
      client.send(JSON.stringify(message));
    });
    client.on('close', () => server.close());
    server.on('close', () => client.close());
  });

  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    toClient,
    toServer,
    connections,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}
