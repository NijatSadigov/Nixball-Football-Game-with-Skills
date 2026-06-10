import type { C2S, S2C } from '../shared/types';

type MsgOf<T extends S2C['t']> = Extract<S2C, { t: T }>;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, ((msg: never) => void)[]>();
  private openHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host + '/ws');
    this.ws = ws;
    ws.onopen = () => this.openHandlers.forEach((f) => f());
    ws.onmessage = (e) => {
      let msg: S2C;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      const list = this.handlers.get(msg.t);
      if (list) for (const h of list) (h as (m: S2C) => void)(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.closeHandlers.forEach((f) => f());
    };
    ws.onerror = () => ws.close();
  }

  on<T extends S2C['t']>(t: T, fn: (msg: MsgOf<T>) => void): void {
    const list = this.handlers.get(t) ?? [];
    list.push(fn as (msg: never) => void);
    this.handlers.set(t, list);
  }

  onOpen(fn: () => void): void {
    this.openHandlers.push(fn);
  }

  onClose(fn: () => void): void {
    this.closeHandlers.push(fn);
  }

  send(msg: C2S): void {
    if (this.connected) this.ws!.send(JSON.stringify(msg));
  }
}
