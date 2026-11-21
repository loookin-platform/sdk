# @loookin/sdk

A small JavaScript SDK that sends product usage events to your Loookin workspace.
It queues events in memory, sends them in batches, retries when the network or
the server fails, and stays out of the way of your page.

- About 3 kB gzipped, no dependencies, ESM only, types included
- Never throws into your code and never blocks the page
- Collects nothing on its own: only what you pass to `track`

Entries for Node.js and automatic page view tracking are coming in later releases.

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

If nothing arrives and debug shows requests failing, check that the origin of
your page (scheme, host and port) is on the key's list of allowed origins. A
browser hides the server's answer from a page whose origin is not allowed, so
the SDK can only report it as a failed request.

One message is printed even without `debug`: an error when a server key
(`ins_...`) is passed to `init`. Server keys must never ship to a browser. The
SDK refuses them and sends nothing.

## What the SDK does not do

- It does not collect anything on its own: no clicks, form contents, page
  content or browser fingerprints.
- It does not use cookies, and it does not use browser storage unless you turn
  on anonymous mode.
- It does not read data back from your workspace.
- It does not persist the queue or sync between tabs.
- It does not link an anonymous visitor's history to the user they sign in as.

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

## License

MIT
