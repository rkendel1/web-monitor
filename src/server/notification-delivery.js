import { createHash } from 'node:crypto';

export const NOTIFICATION_DELIVERIES = 'NotificationDeliveries';
export const MAX_DELIVERY_ATTEMPTS = 3;

function collection(application, name) {
  return application.state.collection(name);
}

function timestamp() {
  return new Date().toISOString();
}

function deliveryId(accountId, attentionEventId, channelId) {
  const hash = createHash('sha256')
    .update(`${accountId}:${attentionEventId}:${channelId}`)
    .digest('hex')
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export function createWebNotificationAdapter() {
  return {
    supports(type) {
      return type === 'web';
    },
    validate(channel) {
      return channel?.type === 'web';
    },
    async deliver() {
      return { deliveryMode: 'durable' };
    }
  };
}

export function createAppNotificationAdapter() {
  return {
    supports(type) {
      return type === 'app';
    },
    validate(channel) {
      return channel?.type === 'app';
    },
    async deliver() {
      return { deliveryMode: 'realtime' };
    }
  };
}

export function createNotificationAdapterRegistry(adapters = [
  createWebNotificationAdapter(),
  createAppNotificationAdapter()
]) {
  return {
    resolve(type) {
      return adapters.find((adapter) => adapter.supports(type));
    }
  };
}

export async function routeAttentionEvent(application, attention) {
  const deliveries = collection(application, NOTIFICATION_DELIVERIES);
  const routes = await collection(application, 'NotificationRoutes').find({
    account_id: attention.account_id,
    event_type: attention.event_type,
    enabled: true
  });
  const created = [];
  for (const route of routes) {
    const channel = await collection(application, 'NotificationChannels').get(route.channel_id);
    if (!channel || channel.account_id !== attention.account_id || channel.enabled !== true) continue;
    const existing = (await deliveries.find({
      account_id: attention.account_id,
      attention_event_id: attention.id,
      channel_id: channel.id
    }))[0];
    if (existing) {
      created.push(existing);
      continue;
    }
    const now = timestamp();
    const delivery = {
      id: deliveryId(attention.account_id, attention.id, channel.id),
      account_id: attention.account_id,
      attention_event_id: attention.id,
      channel_id: channel.id,
      status: 'pending',
      attempt_count: 0,
      created_at: now,
      updated_at: now,
      sent_at: null,
      last_error: null,
      provider_reference: null,
      read_at: null,
      resolved_at: null
    };
    await deliveries.insert(delivery, delivery.id);
    created.push(delivery);
  }
  return created;
}

export async function deliverNotification(application, deliveryIdValue, options = {}) {
  const deliveries = collection(application, NOTIFICATION_DELIVERIES);
  const delivery = await deliveries.get(deliveryIdValue);
  if (!delivery) throw Object.assign(new Error('Notification delivery not found'), { status: 404, code: 'NOT_FOUND' });
  if (delivery.status === 'delivered' || delivery.status === 'suppressed') return delivery;
  if (delivery.attempt_count >= MAX_DELIVERY_ATTEMPTS) {
    await deliveries.update(delivery.id, { status: 'suppressed', updated_at: timestamp() });
    return { ...delivery, status: 'suppressed' };
  }

  const attention = await collection(application, 'AttentionEvents').get(delivery.attention_event_id);
  const channel = await collection(application, 'NotificationChannels').get(delivery.channel_id);
  const routes = attention
    ? await collection(application, 'NotificationRoutes').find({
      account_id: delivery.account_id,
      channel_id: delivery.channel_id,
      event_type: attention.event_type,
      enabled: true
    })
    : [];
  if (!attention || !channel || routes.length === 0 || attention.account_id !== delivery.account_id ||
      channel.account_id !== delivery.account_id || channel.enabled !== true) {
    const update = { status: 'suppressed', updated_at: timestamp(), last_error: 'Ownership or channel validation failed' };
    await deliveries.update(delivery.id, update);
    return { ...delivery, ...update };
  }

  const attempt = delivery.attempt_count + 1;
  await deliveries.update(delivery.id, { status: 'processing', attempt_count: attempt, updated_at: timestamp() });
  const adapter = (options.adapterRegistry ?? createNotificationAdapterRegistry()).resolve(channel.type);
  try {
    if (!adapter || !adapter.validate(channel)) throw new Error(`Unsupported notification channel: ${channel.type}`);
    const result = await adapter.deliver(channel, attention);
    const update = {
      status: 'delivered',
      sent_at: timestamp(),
      updated_at: timestamp(),
      last_error: null,
      ...(result?.providerReference ? { provider_reference: result.providerReference } : {})
    };
    await deliveries.update(delivery.id, update);
    return { ...delivery, ...update, attempt_count: attempt };
  } catch (error) {
    const update = {
      status: attempt >= MAX_DELIVERY_ATTEMPTS ? 'suppressed' : 'failed',
      updated_at: timestamp(),
      last_error: error instanceof Error ? error.message : String(error)
    };
    await deliveries.update(delivery.id, update);
    return { ...delivery, ...update, attempt_count: attempt };
  }
}
