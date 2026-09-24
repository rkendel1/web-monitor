import { appport } from '@appport/runtime';
import { createMonitorRoutes, runMonitorCheck } from './server/monitors.js';

let application;
application = await appport({
  routes: createMonitorRoutes({
    get state() {
      return application.state;
    },
    get jobs() {
      return application.jobs;
    },
    get notifications() {
      return application.notifications;
    }
  }),
  jobs: {
    'monitor.check': async (job) => runMonitorCheck(application, job)
  }
});

await application.start();

const baseUrl = application.http?.url ?? `http://${application.contract.http.host}:${application.contract.http.port}`;
console.log(`AppPort Web Monitor server running at ${baseUrl}`);
