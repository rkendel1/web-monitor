import { appport } from '@appport/services';

const tenantId = process.env.APPPORT_TENANT_ID ?? 'development';
const name = process.env.APPPORT_KEY_NAME ?? 'web-monitor-extension';
const createdBy = process.env.APPPORT_CREATED_BY ?? 'operator';
const scopes = ['monitors.read', 'monitors.write', 'notifications.read', 'notifications.write'];

const application = await appport();
const apiKey = await application.api.keys.createApiKey({
  tenantId,
  name,
  scopes,
  createdBy
});

console.log(JSON.stringify({
  tenantId,
  name,
  scopes,
  keyPrefix: apiKey.keyPrefix,
  secret: apiKey.secret
}, null, 2));

await application.close();
