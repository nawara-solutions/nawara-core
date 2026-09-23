import net from 'node:net';

/**
 * A TCP relay in front of the real broker. Severing it is exactly what a broker restart or a network partition looks like to
 * the AMQP client (every socket dies, new connections are refused) without needing control over the broker process, so the
 * REAL connection/channel lifecycle of amqplib is what is exercised. `start()` after `sever()` re-listens on the same port.
 */
export class BrokerProxy {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly upstreams = new Set<net.Socket>();
  private frozen = false;
  port = 0;
  accepted = 0;
  constructor(private readonly target: { host: string; port: number }) {}
  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      this.accepted++;
      const upstream = net.connect(this.target.port, this.target.host);
      this.upstreams.add(upstream);
      if (this.frozen) upstream.pause();
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => { this.sockets.delete(s); this.upstreams.delete(s); (s === client ? upstream : client).destroy(); });
        s.on('error', () => undefined);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }
  async sever(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  /**
   * Stalls the BROKER-to-client direction without closing anything: the client can still send (a publish reaches the broker) but
   * receives nothing (no publisher confirm, no delivery, no heartbeat) — a stalled or blocked broker, not a dead one.
   */
  freeze(): void {
    this.frozen = true;
    for (const u of this.upstreams) u.pause();
  }
  thaw(): void {
    this.frozen = false;
    for (const u of this.upstreams) u.resume();
  }
  get url(): string {
    return `amqp://guest:guest@127.0.0.1:${this.port}`;
  }
}
