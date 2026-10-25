import { HubConnectionBuilder, HttpTransportType, LogLevel } from '@microsoft/signalr';

const RECONNECT_STEPS_MS = [0, 1000, 3000, 6000, 10000];
const REBUILD_STEPS_MS = [2000, 5000, 10000, 30000];

/**
 * A SignalR hub that keeps itself alive.
 *
 * Two lessons from the chart project are built in:
 *   - Hub-side subscriptions do not survive a reconnect, so `onReady` re-runs the
 *     subscribe calls on every (re)connect, otherwise the socket comes back silent.
 *   - SignalR's own reconnect eventually gives up and closes; the hub is then
 *     rebuilt with backoff, forever.
 * The token goes in accessTokenFactory only. Node sends it as a header; adding it
 * to the URL as well yields a duplicated access_token that the gateway rejects.
 */
export class ManagedHub {
  constructor({ name, url, tokenFactory, handlers, onReady, onState, factory, rebuildStepsMs = REBUILD_STEPS_MS }) {
    this.name = name;
    this.url = url;
    this.tokenFactory = tokenFactory;
    this.handlers = handlers;
    this.onReady = onReady;
    this.onState = onState || (() => {});
    this.factory = factory || ((opts) => buildSignalR(opts));
    this.rebuildStepsMs = rebuildStepsMs;
    this.connection = null;
    this.state = 'idle';
    this.rebuildAttempt = 0;
    this.rebuildTimer = null;
    this.stopping = false;
    this.lastMessageAt = 0;
    this.connectedAt = 0;
  }

  setState(state, info) {
    this.state = state;
    this.onState(state, info);
  }

  async start() {
    this.stopping = false;
    await this.connect();
  }

  async connect() {
    if (this.connection) {
      const stale = this.connection;
      this.connection = null;
      try { await stale.stop(); } catch { /* already gone */ }
    }

    this.setState('connecting');
    const hub = this.factory({ url: this.url, tokenFactory: this.tokenFactory });

    for (const [event, handler] of Object.entries(this.handlers)) {
      hub.on(event, (...args) => {
        this.lastMessageAt = Date.now();
        try {
          handler(...args);
        } catch (err) {
          console.error(`[${this.name}] handler ${event} failed:`, err);
        }
      });
    }

    hub.onreconnecting?.((err) => this.setState('reconnecting', err?.message));
    hub.onreconnected?.(async () => {
      try {
        await this.onReady(hub, { reconnected: true });
        this.setState('connected');
      } catch (err) {
        console.warn(`[${this.name}] resubscribe failed: ${err.message}`);
      }
    });
    hub.onclose?.((err) => {
      if (this.connection !== hub) return;
      this.connection = null;
      this.setState('disconnected', err?.message);
      if (!this.stopping) this.scheduleRebuild();
    });

    try {
      await hub.start();
      this.connection = hub;
      this.connectedAt = Date.now();
      this.rebuildAttempt = 0;
      await this.onReady(hub, { reconnected: false });
      this.setState('connected');
      console.log(`[${this.name}] connected (${this.url})`);
    } catch (err) {
      console.warn(`[${this.name}] connect failed: ${err.message}`);
      this.setState('disconnected', err.message);
      if (!this.stopping) this.scheduleRebuild();
    }
  }

  scheduleRebuild() {
    if (this.rebuildTimer || this.stopping) return;
    const delay = this.rebuildStepsMs[Math.min(this.rebuildAttempt, this.rebuildStepsMs.length - 1)];
    this.rebuildAttempt += 1;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.connect().catch((err) => console.warn(`[${this.name}] rebuild failed: ${err.message}`));
    }, delay);
    this.rebuildTimer.unref?.();
  }

  async invoke(method, ...args) {
    if (!this.connection) throw new Error(`${this.name} is not connected`);
    return this.connection.invoke(method, ...args);
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    const hub = this.connection;
    this.connection = null;
    if (hub) {
      try { await hub.stop(); } catch { /* already stopping */ }
    }
    this.setState('stopped');
  }

  status() {
    return { state: this.state, lastMessageAt: this.lastMessageAt || null, connectedAt: this.connectedAt || null };
  }
}

function buildSignalR({ url, tokenFactory }) {
  return new HubConnectionBuilder()
    .withUrl(url, {
      skipNegotiation: true,
      transport: HttpTransportType.WebSockets,
      accessTokenFactory: tokenFactory,
      timeout: 10000,
    })
    .withAutomaticReconnect(RECONNECT_STEPS_MS)
    .configureLogging(LogLevel.Error)
    .build();
}

/** Market and user hub payloads may be a single object or an array. */
export function entries(payload) {
  if (Array.isArray(payload)) return payload;
  return payload ? [payload] : [];
}
