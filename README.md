# AppPort Web Monitor MVP

This repository contains a minimal end-to-end MVP for an AppPort-backed web monitor:

- a local AppPort service that persists monitors and observations in FeltDB-backed AppPort state
- recurring AppPort jobs that fetch monitored pages and evaluate deterministic monitor conditions
- durable AppPort notification events, with browser notifications as one delivery adapter
- a Manifest V3 Chrome extension for creating, viewing, pausing, resuming, and deleting monitors

A monitor describes **what reality should be observed and when**. An observation
executor determines **how that reality is obtained**. Browser execution is one
observation surface, not the monitoring architecture itself.

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
- `GET /api/observations?subject=<json>&source=<json>&limit=<n>&cursor=<cursor>`
- `GET /api/observations/latest?subject=<json>&source=<json>`

### Chrome extension

The extension provides:

- current-page detection through a content script
- a popup for configuring the AppPort endpoint and creating a monitor
- an options page for viewing monitor history and lifecycle controls
- a service worker that owns AppPort credentials and provides the Chrome notification adapter

## Supported MVP conditions

- `price drops below $500`
- `page contains "Applications Open"`
- `page no longer contains "Sold Out"`
- `status changed`
- `button "Book now" appears`

These map to deterministic structured condition types; arbitrary AI reasoning is intentionally out of scope.

## Local monitor intent compiler

The shared `src/shared/monitor-intent.js` module can use a browser-local WebLLM
runtime to compile a natural-language request into a strict `MonitorDraft`.
The compiler validates and normalizes model output before it can be passed to
monitor creation; it never creates monitors, executes observations, evaluates
conditions, or receives credentials. If the local model is unavailable it
raises an explicit capability error rather than sending the request to a
remote provider. Ambiguous requests return a clarification instead of an
invented monitor.

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

The command writes the extension credential to `.appport/extension-api-key.json` and prints the local file path. Use the `tenantId` and `secret` from that local file when configuring the extension.

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
8. The browser adapter in the extension converts that AppPort event into a Chrome notification
9. Clicking the browser notification opens the monitored URL

Notifications are durable AppPort events. Monitor conditions are evaluated by the
authoritative monitor service, which records a `monitor_triggered` event containing
the observation and evidence before AppPort creates channel delivery state. Browser
notifications are only one delivery adapter; the browser is an observation executor
and notification surface, not the durable monitoring authority. Closing the browser
does not destroy monitor state or already-created notifications.

## Canonical observations

Executors produce observations. Monitors consume observations. An observation is a
durable fact with a stable `id`, normalized `subject` and `source`, executor
metadata, evidence, and authoritative provenance. Browser and service executors
use `browser_page` and `http_request` respectively; submitted provenance is never
trusted over the executor pipeline.

Observation identity is deterministic for a scheduled execution: it is derived
from the execution/job identity (or an explicit pending observation identity),
executor, source, and subject. Retrying that execution therefore reuses the same
observation ID, while a later execution gets a distinct ID even when its values
are unchanged. Trigger IDs remain separate and are derived from the monitor,
observation, and evaluation.

Execution failures and authentication requirements are operational evidence, not
observations. Canonical observations are stored independently in `Observations`;
`MonitorObservations` retains monitor-specific evaluation history during the
incremental migration.

```text
                       External Reality
                              │
                   ┌──────────┴──────────┐
                   │                     │
                Browser               Service
                   │                     │
                   └──────────┬──────────┘
                              ▼
                     ObservationResult
                              │
                              ▼
                        Observation
                 ├── subject / source
                 ├── values / evidence
                 └── provenance / executor
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
                Evaluation            History
                    │
                    ▼
                 Trigger
                    │
                    ▼
               Notification
```

```text
                 Monitor
                    │
                    ▼
            Executor Registry
               │          │
               ▼          ▼
          Browser      Service
               │          │
               └────┬─────┘
                    ▼
             ObservationResult
                    │
                    ▼
             Monitor Evaluation
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
       FeltDB             AppPort
       Evidence           Events
```

## Executor matrix

| Execution mode | Executor | Authentication boundary |
| --- | --- | --- |
| `authenticated_browser` | Browser extension | Browser session / authenticated extension context |
| `service` | HTTP/API service | Service authorization context |

## Limitation in this MVP

The initial service executor can observe HTTP/API responses and ordinary
server-rendered HTML pages, but some heavily client-rendered JavaScript
applications may still require a richer execution environment in a follow-up
iteration.

## Tests

```bash
npm test
```

## Authenticated Page Monitoring

Users can monitor pages that require an existing browser login. The extension observes authenticated pages using the user’s existing browser session without asking the user to provide site credentials or copy authentication tokens into the extension.

### How it Works

1. **Authentication Detection**: When creating a monitor or performing check-ups, the extension analyzes page characteristics to distinguish between `public`, `authenticated`, `authentication_required` (redirected to login), or `unknown` auth states. The legacy `required` value is accepted only at compatibility boundaries and normalized immediately.
2. **Scheduled Checks**: AppPort retains the durable schedule. When a check is due, the monitor resolves an executor through the registry rather than hard-coding browser behavior.
3. **Browser Integration**: If a monitor uses `authenticated_browser`, the service worker sends a lightweight executor heartbeat and periodically polls for pending observations. It opens or activates an appropriate browser tab under the user's existing authenticated context, triggers a content script to run the check safely, and submits the structured observation back to AppPort Services.
4. **Service Integration**: If a monitor uses `service`, AppPort performs the HTTP/API request directly, applies the configured request parameters, resolves any allowed authorization context at execution time, and records the normalized observation or operational evidence.

### Security Model & Safety Boundaries

Our architecture enforces a strict security boundary to protect user credentials:

* **No Credentials Leakage**: The extension never requests, stores, or handles the target site's passwords, raw authentication cookies, or tokens.
* **FeltDB and AppPort Isolation**: No cookies, site passwords, or authorization headers are ever transmitted to AppPort Services or written to FeltDB. All observation payloads are sanitized on the server before database write.
* **Content Script Sandboxing**: Content scripts remain "dumb" and never receive AppPort API keys, access tokens, AuthBoundry credentials, or secrets. All authenticated calls to AppPort Services are made strictly by the service worker.
* **Separate execution state**: Monitor lifecycle (`active`, `paused`, `deleted`) is separate from execution state (`available`, `authentication_required`, `unavailable`, `error`). A closed browser records `unavailable` evidence without pausing or deleting the monitor.
* **Authentication Expiration Protection**: Only an actual authenticated browser observation can transition execution state to `authentication_required`; failed authentication attempts are blocked from becoming target-page observations, preventing false condition matches.
* **Browser credential boundary**: The browser owns the authenticated website session. The extension observes the resulting page but never collects or transmits passwords, cookies, authorization headers, refresh tokens, or other website credentials.
* **Service credential boundary**: Service monitors store only an authorization-context reference. Raw service credentials never enter durable monitor state, observations, trigger events, notifications, logs, or sanitized executor errors.

An unavailable executor never creates a `{ triggered: false }` observation. It creates operational evidence with
`executionState: "unavailable"` and the durable schedule remains authoritative for the next check.

### Permission Model & Minimal Access

We adhere strictly to Chrome's extension security guidance by requesting the minimum browser permissions required for features:

* **Explicit Scope**: The extension only accesses pages that you explicitly choose to monitor.
* **Narrow Host Permissions**: While `<all_urls>` is declared to enable content scripts to load on monitored pages, the extension interacts with and inspects only the specific target URLs configured for active, registered monitors.
* **activeTab Permission**: Used for user-initiated monitor creation to avoid requesting broad or unnecessary early host permissions before the user registers a target page.
