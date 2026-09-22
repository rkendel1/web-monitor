# AppPort Web Monitor MVP

This repository contains a minimal end-to-end MVP for an AppPort-backed web monitor:

- a local AppPort service that persists monitors and observations in FeltDB-backed AppPort state
- recurring AppPort jobs that fetch monitored pages and evaluate deterministic monitor conditions
- AppPort notifications that the Chrome extension turns into browser notifications
- a Manifest V3 Chrome extension for creating, viewing, pausing, resuming, and deleting monitors

## What ships in this MVP

### AppPort service

The local service uses `@appport/services` for:

- API key authentication
- recurring jobs and schedules
- notification persistence and delivery state
- FeltDB-backed durable monitor and observation state via AppPort's `application.state`

Custom monitor routes are exposed at:

- `GET /api/session`
- `GET /api/monitors`
- `GET /api/monitor?id=<monitorId>`
- `POST /api/monitors`
- `POST /api/monitors/pause`
- `POST /api/monitors/resume`
- `POST /api/monitors/delete`

### Chrome extension

The extension provides:

- current-page detection through a content script
- a popup for configuring the AppPort endpoint and creating a monitor
- an options page for viewing monitor history and lifecycle controls
- a service worker that owns AppPort credentials and syncs AppPort notifications into Chrome notifications

## Supported MVP conditions

- `price drops below $500`
- `page contains "Applications Open"`
- `page no longer contains "Sold Out"`
- `status changed`
- `button "Book now" appears`

These map to deterministic structured condition types; arbitrary AI reasoning is intentionally out of scope.

## Run the AppPort service

```bash
npm install
npm run start
```

The service listens on `http://127.0.0.1:8787` by default and stores durable local AppPort state in `.appport/state`.

## Create an extension API key

Create a key for the extension with the existing AppPort API-key capability:

```bash
npm run create:api-key
```

Save the returned `tenantId` and `secret`.

## Load the unpacked extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository root (`/home/runner/work/web-monitor/web-monitor`)
5. Open the extension popup
6. Enter:
   - Service URL: `http://127.0.0.1:8787`
   - Tenant ID: `development`
   - API key: the secret from `npm run create:api-key`

## End-to-end flow

1. Visit a page such as `https://example.com/product/123`
2. Open the popup and enter `price drops below $500`
3. Choose a schedule such as `Every hour`
4. Click **Monitor this page**
5. The service creates a durable monitor record plus an AppPort recurring job schedule
6. AppPort persists monitor state and every observation through FeltDB
7. When the condition transitions to true, AppPort creates a notification
8. The extension service worker converts that AppPort notification into a Chrome notification
9. Clicking the browser notification opens the monitored URL

## Limitation in this MVP

Scheduled checks fetch and evaluate ordinary server-rendered HTML pages. Some heavily client-rendered JavaScript applications may require a richer execution environment or additional extraction strategies in a follow-up iteration.

## Tests

```bash
npm test
```
