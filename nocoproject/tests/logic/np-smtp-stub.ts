/**
 * A minimal in-process SMTP server for tests (NP-88): accepts every message without TLS or authentication and keeps
 * the raw DATA of each one, so a test can send through the real notification plugin's SMTP provider and read back
 * what would have reached the mailbox.
 */
import { createServer, type AddressInfo, type Socket } from 'node:net';

export interface SmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly data: string;
}

export interface SmtpStub {
  readonly port: number;
  readonly messages: SmtpMessage[];
  close(): Promise<void>;
}

function serve(socket: Socket, messages: SmtpMessage[]): void {
  let buffer = '';
  let from = '';
  let to: string[] = [];
  let data: string[] | null = null;
  const reply = (line: string) => socket.write(`${line}\r\n`);
  reply('220 np-smtp-stub ready');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (data) {
        if (line === '.') {
          messages.push({ from, to, data: data.join('\n') });
          data = null;
          from = '';
          to = [];
          reply('250 queued');
        } else data.push(line.startsWith('..') ? line.slice(1) : line);
        continue;
      }
      const command = line.slice(0, 4).toUpperCase();
      if (command === 'EHLO' || command === 'HELO') reply('250 np-smtp-stub');
      else if (command === 'MAIL') {
        from = /<([^>]*)>/u.exec(line)?.[1] ?? '';
        reply('250 ok');
      } else if (command === 'RCPT') {
        to.push(/<([^>]*)>/u.exec(line)?.[1] ?? '');
        reply('250 ok');
      } else if (command === 'DATA') {
        data = [];
        reply('354 end with .');
      } else if (command === 'QUIT') {
        reply('221 bye');
        socket.end();
      } else reply('250 ok');
    }
  });
  socket.on('error', () => undefined);
}

export async function startSmtpStub(): Promise<SmtpStub> {
  const messages: SmtpMessage[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, messages);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
