/**
 * Persist a notification event through AppPort.
 *
 * Delivery is intentionally not part of the event write. AppPort owns the
 * durable event and each consumer may provide its own delivery adapter.
 */
export function createNotificationEvent(application, event, principal) {
  const {
    tenantId,
    recipient,
    type,
    title,
    body,
    priority = 'normal',
    source,
    data
  } = event;

  return application.notifications.create({
    tenantId,
    recipient,
    type,
    title,
    body,
    priority,
    source,
    data
  }, principal);
}
