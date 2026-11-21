# @loookin/sdk

A small JavaScript SDK that sends product usage events to your Loookin workspace.
It queues events in memory, sends them in batches, retries when the network or
the server fails, and stays out of the way of your page.

- Under 4 kB gzipped in the browser, no dependencies, ESM only, types included
- Never throws into your code and never blocks the page
- Collects nothing on its own: only what you pass to `track`, plus page views
  and campaign arrivals if you turn them on

## Install

```sh
npm install @loookin/sdk
```

## Usage

You need a publishable key (`pub_...`) from your workspace, with the origin of
your site on the key's list of allowed origins.

```js
import { loookin } from "@loookin/sdk";

// 1. Once, when your app starts
loookin.init({ workspace: "acme", key: "pub_..." });

// 2. When you know who the user is
loookin.identify("user_8421", { company: "company_193" });

// 3. Wherever something worth measuring happens
loookin.track("report_exported", { format: "pdf", pages: 12 });
```

Use stable, pseudonymous ids for `user` and `company`. Do not pass e-mail
addresses, names or phone numbers: the server rejects them.

Event and property names are lowercase letters, digits and single underscores.
Property values are flat: text, number, boolean or `null`.

### API

| Call | What it does |
|---|---|
| `loookin.init(options)` | Configures the client. A second call is ignored. |
| `loookin.identify(user, { company? })` | Sets who the following events belong to and releases events that were waiting. |
| `loookin.track(event, properties?)` | Queues an event. Never throws. |
| `loookin.flush()` | Sends the queue now. Returns a promise that resolves after the attempt. |
| `loookin.reset()` | Forgets the identity, for example on logout. |

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `workspace` | `string` | required | Workspace slug (`"acme"`) or its full origin (`"https://acme.loookin.com"`) |
| `key` | `string` | required | Publishable key, `pub_...` |
| `anonymous` | `boolean` | `false` | Measure visitors before `identify`, see below |
| `autoTrack` | `{ pageViews?: boolean; campaigns?: boolean }` | both `false` | Events the SDK sends on its own, see below |
| `appVersion` | `string` | none | Sent with every event as `context.app_version` |
| `session` | `string` | none | Sent with every event as `context.session` |
| `debug` | `boolean` | `false` | Log what is sent and what the server answered |
| `dryRun` | `boolean` | `false` | The server validates events but stores nothing |

Every event also carries `context.platform = "web"` and `context.device_type`
(`mobile`, `tablet` or `desktop`, from the window width).

## How events are sent

- Events wait in an in-memory queue and leave in batches: every 10 seconds,
  as soon as 30 are waiting, and when the page is hidden or closed.
- Each event gets its id and timestamp when you call `track`, not when it is
  sent. The server deduplicates by id, so a retry never counts twice.
- On a network error, a 5xx answer or a rate limit the same batch is sent
  again, with a growing delay of up to a minute.
- If the server refuses the key, the origin, or the workspace is over its
  quota, the SDK stops sending until the next page load.
- The queue holds at most 1000 events. When it is full, the oldest are dropped.
  The queue is not persisted: events that were not sent are gone when the page
  closes.

### Before `identify`

Every event needs a user. By default, events tracked before `identify` wait in
the queue and are sent under that user once you call it. If `identify` never
comes, they are never sent.

After `reset()`, new events wait for the next `identify` again.

## Anonymous mode

```js
loookin.init({ workspace: "acme", key: "pub_...", anonymous: true });
```

With `anonymous: true` the SDK measures visitors who are not signed in. It
creates a random id, stores it in the visitor's browser (`localStorage`, under
the key `loookin_device`) and uses it as the user until you call `identify`.

Please note:

- This stores an identifier on the visitor's device. Whether you need the
  visitor's consent for that, and how you ask for it, is your responsibility as
  the site owner. Turn the option on only after you have what you need.
- After `identify`, new events go under the identified user. Earlier anonymous
  events keep the device id. The two histories are not merged.
- `reset()` creates a new device id.
- If the browser blocks storage, the id lives only as long as the page.

Without `anonymous: true` the SDK never reads or writes `localStorage`,
`sessionStorage` or cookies.

## Auto-tracking

Off by default. Turn on what you want in `init`:

```js
loookin.init({
  workspace: "acme",
  key: "pub_...",
  autoTrack: { pageViews: true, campaigns: true },
});
```

| Option | Event | Properties | When |
|---|---|---|---|
| `pageViews` | `page_viewed` | `page` (the path), `referrer` (on the first view, when there is one) | On `init`, and whenever the path changes without a page load (`history.pushState`, `history.replaceState`, back and forward) |
| `campaigns` | `campaign_arrived` | `utm_source`, `utm_medium`, `utm_campaign` (those present in the address), `landing_page` (the path) | Once per page load, when the address has at least one of the three parameters |

These events go through the same queue as your own. They need a user like any
other event: without anonymous mode they wait for `identify`. They also count
toward your workspace's event quota.

Only the path is sent as `page` and `landing_page`, never the query string or
the hash. With `pageViews` on, the SDK wraps `history.pushState` and
`history.replaceState`; with it off, it does not touch them.

## Debug and dry run

```js
loookin.init({ workspace: "acme", key: "pub_...", debug: true, dryRun: true });
```

`debug: true` prints to the console what the SDK is doing: every batch it
sends, every event the server rejected with the reason and a suggested fix,
users that are being throttled, and why sending stopped. Without it the SDK
prints nothing.

`dryRun: true` asks the server to validate your events without storing them.
Combine it with `debug` to see what would be accepted while you wire things up,
without filling your workspace with test data.

If the server refuses the origin of your page or the key itself, the SDK says
so once under `debug` and stops sending until the next page load. To fix a
refused origin, add the origin of your page (scheme, host and port) to the
key's list of allowed origins.

One message is printed even without `debug`: an error when a server key
(`ins_...`) is passed to `init`. Server keys must never ship to a browser. The
SDK refuses them and sends nothing.

## What the SDK does not do

- It does not collect anything on its own: no clicks, form contents, page
  content or browser fingerprints. Page views and campaign arrivals are sent
  only if you turn them on.
- It does not use cookies, and it does not use browser storage unless you turn
  on anonymous mode.
- It does not read data back from your workspace.
- It does not persist the queue or sync between tabs.
- It does not link an anonymous visitor's history to the user they sign in as.

## From your server

Events that happen on your backend (an order, a webhook, an import) are sent
with a server key (`ins_...`) from Node.js 22 or newer. A server has no current
user, so every event names its `company`, its `user`, or both.

```js
import { createClient } from "@loookin/sdk/node";

const loookin = createClient({ workspace: "acme", key: process.env.LOOOKIN_KEY });

const result = loookin.track({
  event: "order_placed",
  company: "company_193",
  user: "user_8421",
  properties: { total: 129.5, currency: "EUR" },
  context: { source: "api" },
});
if (!result.ok) console.warn(result.error);

// Before the process exits (scripts, serverless functions):
await loookin.shutdown();
```

| Call | What it does |
|---|---|
| `createClient({ workspace, key, debug?, dryRun? })` | Creates a client. You can create as many as you need. |
| `client.track({ event, company?, user?, properties?, timestamp?, context? })` | Queues an event and returns `{ ok: true }`, or `{ ok: false, error }` when the event cannot be sent as given. Never throws. |
| `client.flush()` | Sends the queue now. Resolves after the attempt. |
| `client.shutdown()` | Sends what is queued, waits for it and stops the client. |

`timestamp` is an ISO 8601 string or a `Date`; it defaults to now. `context`
may carry `source`, `session`, `device_type`, `app_version` and `os`;
`platform` is always `"server"`. Batching, retries and `debug` / `dryRun` work
as in the browser. The flush timer does not keep your process alive, so call
`shutdown()` (or `flush()`) before exiting, otherwise queued events are lost.

Keep server keys on the server. Never put one into code that ships to a browser.

## Server-side rendering

Importing the package where `window` does not exist is safe. All calls are
no-ops there, so you can call `track` from code that also runs on the server.

## Requirements

Current versions of Chrome, Edge, Firefox and Safari. For development, Node.js 22 or newer.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run size   # fails if the gzipped browser entry is over 5 kB
```

A page for trying the browser entry by hand is in `examples/browser/index.html`
(build first, then serve the repository root over http). A script for the
server entry is in `examples/node/send.mjs`.

## Releasing

For maintainers. Releases are published to npm by the `Release` workflow when a
version tag is pushed. It uses npm trusted publishing, so there is no token to
manage.

1. Update `version` in `package.json` (and `package-lock.json`, for example
   with `npm version 0.2.0 --no-git-tag-version`) in a pull request and merge it.
2. Tag the merged commit: `git tag v0.2.0`. The tag must match the version in
   `package.json`, otherwise the workflow stops before publishing.
3. Push the tag: `git push origin v0.2.0`.

A change that breaks existing calls needs a new major version.

## License

MIT
