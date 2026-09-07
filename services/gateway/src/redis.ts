import { Redis } from 'ioredis';
import { config } from './config.js';
import { OutboundEvent } from './types.js';

export type EventCallback = (conversationId: string, event: OutboundEvent) => void;

export class RedisPubSub {
  private pub: Redis;
  private sub: Redis;
  private onEventHandler?: EventCallback;

  constructor(redisUrl = config.redisUrl) {
    this.pub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.sub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });

    this.sub.on('pmessage', (_pattern, channel, message) => {
      try {
        const conversationId = channel.replace('livechat:conv:', '');
        const event = JSON.parse(message) as OutboundEvent;
        if (this.onEventHandler) {
          this.onEventHandler(conversationId, event);
        }
      } catch (e) {
        console.error('Gagal parse pesan redis pubsub:', e);
      }
    });
  }

  async init(): Promise<void> {
    await this.sub.psubscribe('livechat:conv:*');
  }

  setEventHandler(handler: EventCallback): void {
    this.onEventHandler = handler;
  }

  async publish(conversationId: string, event: OutboundEvent): Promise<void> {
    const channel = `livechat:conv:${conversationId}`;
    await this.pub.publish(channel, JSON.stringify(event));
  }

  async close(): Promise<void> {
    try {
      await this.sub.punsubscribe('livechat:conv:*');
    } catch {}
    try {
      await Promise.race([
        Promise.all([this.sub.quit(), this.pub.quit()]),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    } catch {}
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
