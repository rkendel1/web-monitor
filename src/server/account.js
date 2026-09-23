import { randomUUID } from 'node:crypto';
import { NOTIFICATION_DELIVERIES, routeAttentionEvent } from './notification-delivery.js';

export const NOTIFICATION_CHANNELS = 'NotificationChannels';
export const NOTIFICATION_ROUTES = 'NotificationRoutes';
export const ATTENTION_EVENTS = 'AttentionEvents';

function collection(application, name) {
  return application.state.collection(name);
}

function requirePrincipal(principal) {
  if (!principal) {
    throw Object.assign(new Error('Authentication is required'), { status: 401, code: 'UNAUTHENTICATED' });
  }
  return principal;
}

function requireScope(principal, scopes) {
  if (!scopes.some((scope) => (principal.scopes ?? []).includes(scope))) {
    throw Object.assign(new Error(`One of the ${scopes.join(', ')} scopes is required`), {
      status: 403,
      code: 'FORBIDDEN'
    });
  }
}

function accountId(tenantId, principal) {
  if (principal.tenantId && tenantId && principal.tenantId !== tenantId) {
    throw Object.assign(new Error('Account access is forbidden'), { status: 403, code: 'FORBIDDEN' });
  }
  return tenantId ?? principal.tenantId;
}

function timestamp() {
  return new Date().toISOString();
}

function sortNewestFirst(items) {
  return [...items].sort((left, right) => String(right.updated_at ?? right.created_at).localeCompare(
    String(left.updated_at ?? left.created_at)
  ));
}

function channelCapabilities(type) {
  return type === 'app'
    ? { type, surface: 'in_app', delivery: 'realtime', available: true, supported_event_types: ['important', 'critical'] }
    : { type, surface: 'in_app', delivery: 'durable', available: type === 'web', supported_event_types: ['important', 'critical'] };
}

function withCapabilities(channel) {
  return { ...channel, capabilities: channelCapabilities(channel.type) };
}

async function getChannel(application, id, account) {
  const channel = await collection(application, NOTIFICATION_CHANNELS).get(id);
  if (!channel || channel.account_id !== account) {
    throw Object.assign(new Error('Notification channel not found'), { status: 404, code: 'NOT_FOUND' });
  }
  return withCapabilities(channel);
}

async function getRoute(application, id, account) {
  const route = await collection(application, NOTIFICATION_ROUTES).get(id);
  if (!route || route.account_id !== account) {
    throw Object.assign(new Error('Notification route not found'), { status: 404, code: 'NOT_FOUND' });
  }
  return route;
}

export async function createAttentionEvent(application, event) {
  const existing = await collection(application, ATTENTION_EVENTS).get(event.id);
  if (existing) {
    await routeAttentionEvent(application, existing);
    return existing;
  }
  const created_at = event.created_at ?? timestamp();
  const id = event.id ?? randomUUID();
  const routes = await collection(application, NOTIFICATION_ROUTES).find({
    account_id: event.account_id,
    event_type: event.event_type,
    enabled: true
  });
  const channelIds = [];
  for (const route of routes) {
    const channel = await collection(application, NOTIFICATION_CHANNELS).get(route.channel_id);
    if (channel?.account_id === event.account_id && channel.enabled === true) {
      channelIds.push(channel.id);
    }
  }
  const attention = {
    id,
    account_id: event.account_id,
    source_type: event.source_type,
    source_id: event.source_id,
    event_type: event.event_type,
    importance: event.importance ?? 'normal',
    title: event.title,
    summary: event.summary ?? event.body ?? '',
    evidence_id: event.evidence_id ?? null,
    channel_ids: [...new Set(channelIds)],
    created_at
  };
  await collection(application, ATTENTION_EVENTS).insert(attention, id);
  await routeAttentionEvent(application, attention);
  return attention;
}

export function createAccountRoutes(application) {
  const read = ['account.read', 'notifications.read', 'monitors.read'];
  const write = ['account.write', 'notifications.write', 'monitors.write'];

  const channelList = async ({ tenantId, principal }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, read);
    const account = accountId(tenantId, authenticated);
    return { items: sortNewestFirst(await collection(application, NOTIFICATION_CHANNELS).find({ account_id: account })).map(withCapabilities) };
  };

  const channelCreate = async ({ tenantId, principal, body }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    if (!body?.type || typeof body.type !== 'string') {
      throw Object.assign(new Error('Channel type is required'), { status: 400, code: 'INVALID_INPUT' });
    }
    const created_at = timestamp();
    const channel = {
      id: randomUUID(),
      account_id: account,
      type: body.type,
      name: body.name ?? body.type,
      configuration: body.configuration ?? {},
      enabled: body.enabled !== false,
      created_at,
      updated_at: created_at
    };
    await collection(application, NOTIFICATION_CHANNELS).insert(channel, channel.id);
    return withCapabilities(channel);
  };

  const channelRead = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, read);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    return getChannel(application, id, account);
  };

  const channelUpdate = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    const existing = await getChannel(application, id, account);
    const update = Object.fromEntries(Object.entries(body ?? {}).filter(([key]) =>
      ['type', 'name', 'configuration', 'enabled'].includes(key)));
    update.updated_at = timestamp();
    await collection(application, NOTIFICATION_CHANNELS).update(id, update);
    return { ...existing, ...update };
  };

  const channelDelete = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    await getChannel(application, id, account);
    await collection(application, NOTIFICATION_CHANNELS).delete(id);
    return { ok: true };
  };

  const routeList = async ({ tenantId, principal }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, read);
    return { items: sortNewestFirst(await collection(application, NOTIFICATION_ROUTES).find({
      account_id: accountId(tenantId, authenticated)
    })) };
  };

  const routeCreate = async ({ tenantId, principal, body }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const channel = await getChannel(application, body?.channel_id, account);
    const created_at = timestamp();
    const route = {
      id: randomUUID(),
      account_id: account,
      channel_id: channel.id,
      event_type: body?.event_type ?? 'important',
      enabled: body?.enabled !== false,
      created_at,
      updated_at: created_at
    };
    await collection(application, NOTIFICATION_ROUTES).insert(route, route.id);
    return route;
  };

  const routeUpdate = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    const existing = await getRoute(application, id, account);
    if (body?.channel_id !== undefined) await getChannel(application, body.channel_id, account);
    const update = Object.fromEntries(Object.entries(body ?? {}).filter(([key]) =>
      ['channel_id', 'event_type', 'enabled'].includes(key)));
    update.updated_at = timestamp();
    await collection(application, NOTIFICATION_ROUTES).update(id, update);
    return { ...existing, ...update };
  };

  const routeDelete = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    await getRoute(application, id, account);
    await collection(application, NOTIFICATION_ROUTES).delete(id);
    return { ok: true };
  };

  const attentionList = async ({ tenantId, principal }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, read);
    return {
      items: sortNewestFirst(await collection(application, ATTENTION_EVENTS).find({
        account_id: accountId(tenantId, authenticated)
      }))
    };
  };

  const notificationList = async ({ tenantId, principal }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, read);
    const account = accountId(tenantId, authenticated);
    const deliveries = await collection(application, NOTIFICATION_DELIVERIES).find({ account_id: account });
    const attention = collection(application, ATTENTION_EVENTS);
    return {
      items: sortNewestFirst(await Promise.all(deliveries.map(async (delivery) => ({
        ...delivery,
        attention: await attention.get(delivery.attention_event_id)
      }))))
    };
  };

  const notificationRead = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    const delivery = await collection(application, NOTIFICATION_DELIVERIES).get(id);
    if (!delivery || delivery.account_id !== account) throw Object.assign(new Error('Notification delivery not found'), { status: 404, code: 'NOT_FOUND' });
    const update = { read_at: delivery.read_at ?? timestamp(), updated_at: timestamp() };
    await collection(application, NOTIFICATION_DELIVERIES).update(id, update);
    return { ...delivery, ...update };
  };

  const notificationResolve = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, write);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    const delivery = await collection(application, NOTIFICATION_DELIVERIES).get(id);
    if (!delivery || delivery.account_id !== account) throw Object.assign(new Error('Notification delivery not found'), { status: 404, code: 'NOT_FOUND' });
    const update = { resolved_at: delivery.resolved_at ?? timestamp(), updated_at: timestamp() };
    await collection(application, NOTIFICATION_DELIVERIES).update(id, update);
    return { ...delivery, ...update };
  };

  const notificationGet = async ({ tenantId, principal, body, request, params }) => {
    const authenticated = requirePrincipal(principal);
    requireScope(authenticated, read);
    const account = accountId(tenantId, authenticated);
    const id = params?.id ?? body?.id ?? new URL(request?.url ?? '/', 'http://web-monitor.local').searchParams.get('id');
    const delivery = await collection(application, NOTIFICATION_DELIVERIES).get(id);
    if (!delivery || delivery.account_id !== account) throw Object.assign(new Error('Notification delivery not found'), { status: 404, code: 'NOT_FOUND' });
    return { ...delivery, attention: await collection(application, ATTENTION_EVENTS).get(delivery.attention_event_id) };
  };

  return {
    'GET /account/channels': channelList,
    'POST /account/channels': channelCreate,
    'GET /account/channels/:id': channelRead,
    'PATCH /account/channels/:id': channelUpdate,
    'DELETE /account/channels/:id': channelDelete,
    'GET /account/channel': channelRead,
    'PATCH /account/channels': channelUpdate,
    'DELETE /account/channels': channelDelete,
    'GET /account/notification-routes': routeList,
    'POST /account/notification-routes': routeCreate,
    'PATCH /account/notification-routes/:id': routeUpdate,
    'DELETE /account/notification-routes/:id': routeDelete,
    'PATCH /account/notification-routes': routeUpdate,
    'DELETE /account/notification-routes': routeDelete,
    'GET /account/attention': attentionList,
    'GET /account/notifications': notificationList,
    'GET /account/notifications/:id': notificationGet,
    'POST /account/notifications/:id/read': notificationRead,
    'POST /account/notifications/:id/resolve': notificationResolve,
    'GET /account/notification-capabilities': async () => ({ items: ['web', 'app'].map(channelCapabilities) }),
    'GET /api/account/channels': channelList,
    'POST /api/account/channels': channelCreate,
    'GET /api/account/channels/:id': channelRead,
    'PATCH /api/account/channels/:id': channelUpdate,
    'DELETE /api/account/channels/:id': channelDelete,
    'GET /api/account/channel': channelRead,
    'PATCH /api/account/channels': channelUpdate,
    'DELETE /api/account/channels': channelDelete,
    'GET /api/account/notification-routes': routeList,
    'POST /api/account/notification-routes': routeCreate,
    'PATCH /api/account/notification-routes/:id': routeUpdate,
    'DELETE /api/account/notification-routes/:id': routeDelete,
    'PATCH /api/account/notification-routes': routeUpdate,
    'DELETE /api/account/notification-routes': routeDelete,
    'GET /api/account/attention': attentionList,
    'GET /api/account/notifications': notificationList,
    'GET /api/account/notifications/:id': notificationGet,
    'POST /api/account/notifications/:id/read': notificationRead,
    'POST /api/account/notifications/:id/resolve': notificationResolve,
    'GET /api/account/notification-capabilities': async () => ({ items: ['web', 'app'].map(channelCapabilities) })
  };
}
