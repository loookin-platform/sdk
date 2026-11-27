# @loookin/sdk

A small JavaScript SDK that sends product usage events to your Loookin workspace
and shows its in-app surveys. It queues events in memory, sends them in batches,
retries when the network or the server fails, and stays out of the way of your page.

- Under 5 kB gzipped in the browser, no dependencies, ESM only, types included;
  the survey renderer (under 18 kB) is loaded only when there is a survey to show
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
| `loookin.flush()` | Sends the queue now, without waiting for a retry delay. Returns a promise that resolves after the attempt. |
| `loookin.reset()` | Forgets the identity, for example on logout. |
| `loookin.stop()` | Drops everything that is queued, removes the stored device id and sends nothing more until the page reloads, for example when a user opts out. Also closes an open survey and removes every listener the surveys added. |
| `loookin.showSurvey(key)` | Shows an in-app survey now, without waiting for its triggers. Returns a promise of `true` when it was shown. Never rejects. See [Surveys](#surveys). |

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
| `surveys` | `boolean \| { language?: string; webFonts?: boolean }` | `true` | In-app surveys, see [Surveys](#surveys). `false` turns them off |

Every event also carries `context.platform = "web"` and `context.device_type`
(`mobile`, `tablet` or `desktop`, from the window width).

## How events are sent

- Events wait in an in-memory queue and leave in batches: every 10 seconds,
  as soon as 30 are waiting, and when the page is hidden or closed.
- Each event gets its id and timestamp when you call `track`, not when it is
  sent. The server deduplicates by id, so a retry never counts twice.
- On a network error, a 5xx answer, a rate limit, no answer within 15 seconds
  or an answer that does not come from Loookin (a proxy or login page) the
  same batch is sent again, with a growing delay of up to a minute. When the
  page is hidden or closed, or you call `flush()`, the SDK does not wait for
  that delay.
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
`sessionStorage` or cookies. The one exception is `stop()`, which always
removes `loookin_device`, in case an earlier visit stored it.

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
| `pageViews` | `page_viewed` | `page` (the path), `referrer` (origin and path of the page the visitor came from; on the first view, when there is one) | On `init`, and whenever the path changes without a page load (`history.pushState`, `history.replaceState`, back and forward) |
| `campaigns` | `campaign_arrived` | `utm_source`, `utm_medium`, `utm_campaign` (those present in the address), `landing_page` (the path) | Once per page load, when the address has at least one of the three parameters |

These events go through the same queue as your own. They need a user like any
other event: without anonymous mode they wait for `identify`. They also count
toward your workspace's event quota.

Only the path is sent as `page` and `landing_page`, and only the origin and
path as `referrer`: never the query string or the hash, of your page or of the
page the visitor came from. With `pageViews` on, the SDK wraps `history.pushState` and
`history.replaceState`. With it off, it touches them only once a survey could be
shown, to notice in-app navigation (see [Surveys](#surveys)).

## Surveys

Surveys you build in your workspace with the type **Popup** or **Modal** show
up inside your app, without a new deploy. They are on by default.

```js
loookin.init({ workspace: "acme", key: "pub_..." });
loookin.identify("user_8421", { company: "company_193" });
// The SDK asks which surveys apply to this user and shows them when their
// triggers hold. Nothing else to do.

// Optional: show one by its key, skipping its triggers.
const shown = await loookin.showSurvey("nps-q3");
```

How it works:

- After `identify` (and after every change of identity) the SDK makes one
  request, `POST /api/sdk/surveys`, with the user and company ids. In
  anonymous mode it asks as `{ anonymous: true }` and gets only surveys meant
  for everyone; the SDK then remembers in `localStorage` (`loookin_surveys`,
  next to the device id) which surveys this device was shown, closed or
  answered, so they do not come back on every visit. Without `identify` and
  without anonymous mode it does not ask.
- The answer is the list of surveys that apply right now, already decided by
  the server (audience, rollout, limits, repeats). The SDK asks again only
  when that list is older than the time the server gave it (5 minutes, or an
  hour when the workspace has nothing to show) and the page navigates, the
  tab becomes visible again, a trigger is about to show a survey or you call
  `showSurvey`. There is no background timer. A navigation is a new path,
  `pushState`, back and forward or a hash change; a `replaceState` that only
  changes the query or the hash (a search box) is not one.
- When the list is empty, nothing more happens: the renderer
  (`@loookin/sdk/surveys`, a separate file of the package) is not loaded.
- A survey is shown only after the server accepted its view; if that request
  fails or is rate limited, the survey does not show and nothing more is sent.
- Triggers are evaluated in the browser: page load (any page or URL rules,
  also on in-app navigation), an event you `track`, an element becoming
  visible, a click on an element, time on page and exit intent (mouse only).
  Nothing is sent to evaluate them.
- At most one survey is on screen. When several apply, the one with the
  higher priority comes first; the next one waits for the next address change.
  A survey shown in one tab is not shown in another.
- `reset()` and a new identity close an open survey and drop the list.
  `stop()` also removes every listener the surveys added.
- `showSurvey(key)` skips the triggers, not the server's decision: a survey
  that is paused, out of its audience or over its limits is not shown, and
  the promise resolves to `false`. It also resolves to `false` while another
  survey is open, before `init` and `identify`, and with `surveys: false`.
- Answers and the run (shown, started, steps, closed) are sent to
  `/api/sdk/surveys/{key}/events` and `/api/sdk/surveys/{key}/responses` of
  your workspace. Requests time out after 5 seconds and are never retried. If
  Loookin is slow or down, your app works as before and no survey shows.

| Option | Meaning |
|---|---|
| `surveys: true` (default) | Ask for surveys and show them |
| `surveys: false` | Never ask, never draw anything |
| `surveys: { language: "de" }` | On, and send the visitor's preferred language with the request (the server shows each survey in its default language for now) |
| `surveys: { webFonts: true }` | On, and load the web font a survey's Design names, see below |

Formats in this version: **Popup** (a card in the corner the survey's Design
sets, at the bottom across the full width on a narrow screen) and **Modal**
(a card in the middle with an optional backdrop, a sheet from the bottom on a
narrow screen). Surveys of the types Banner, Tooltip and Embed are ignored by
this version, silently; they come with a later version, and so do definitions
with a newer schema than the SDK knows.

What the SDK adds to your page while a survey is open:

- One element, `<loookin-survey>`, appended to `document.body`. Everything
  is drawn inside its shadow root, with its styles inside too: your CSS does
  not change the survey and the survey's CSS does not change your page. Text
  from the survey is always inserted as text, never as HTML. Icons are inline
  SVG; no icon font and no code is loaded from the network.
- Where the browser supports it, the element is shown in the top layer
  (`popover="manual"`), so a `transform` on your `body` or a high z-index does
  not misplace it. If its styles cannot apply (for example a CSP that blocks
  them), the survey closes at once and is not shown.
- For a Modal, `overflow: hidden` on `<html>` so that the page does not scroll
  behind it, put back exactly as it was when the Modal closes. A Modal moves
  the keyboard focus into the survey and returns it afterwards, and Escape
  always closes it, also without a close button. A Popup never takes the
  focus; Escape closes it when it has a close button. When sending an answer
  fails, every survey offers Close next to trying again, so a survey never
  traps your app. If your app removes the element (a framework replacing
  `body`), the survey counts as closed.
- The survey uses your page's font, even when its Design names another. With
  `surveys: { webFonts: true }` it uses the Design's font, and for a web font
  (for example Poppins) adds the Google Fonts stylesheet to `document.head`,
  as the hosted survey page does, removing it when the survey closes. That
  makes the visitor's browser contact Google (`fonts.googleapis.com` for the
  stylesheet, `fonts.gstatic.com` for the font files), which tells Google the
  visitor's IP address and that your page used the font. A strict CSP needs
  `style-src https://fonts.googleapis.com` and `font-src https://fonts.gstatic.com`.
  System fonts and the default (Inherit from app) load nothing.
- A survey for one of the survey's Test users shows a "Test" label; the server
  records nothing from such a run.

What it never does: it does not collect clicks or page content (the click
trigger listens only for the selectors your surveys name, and nothing is sent
before a survey is shown), it does not use cookies, it uses browser storage
for surveys only in anonymous mode, and it does not load code from your
workspace at run time: the renderer is part of the package you install.

### What a workspace can make the SDK do in your page

Survey definitions come from your workspace, so it is worth knowing their
reach. A definition can only put text on the page (always as text, never as
markup; the build fails if the code could insert HTML or run code), colours
that are validated `#rrggbb` values, a font from a fixed list, and one of four
positions. CSS selectors in triggers are only used to match elements
(`:has(` is refused, at most 20 elements per selector are observed); URL rules
are only compared with the address. A malformed definition is skipped.
Nothing about your page is sent to evaluate triggers, but a survey that is
shown tells the workspace one bit: that its conditions held on that page for
that user (for example that an element matching its selector was clicked).

Your publishable key must allow the origin of your app, as for events.

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
  on anonymous mode (`stop()` only removes the device id).
- It does not read data back from your workspace, except the list of surveys
  that apply to the current user.
- It does not persist the queue or sync between tabs.
- It does not link an anonymous visitor's history to the user they sign in as.

## From your server

Events that happen on your backend (an order, a webhook, an import) are sent
with a server key (`ins_...`) from Node.js 22 or newer. A server has no current
user, so every event names its `company`, its `user`, or both.

```js
import { createClient } from "@loookin/sdk/node";

const loookin = createClient({ workspace: "acme", key: process.env.LOOOKIN_KEY ?? "" });

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
| `client.flush()` | Sends the queue now, without waiting for a retry delay. Resolves after the attempt. |
| `client.shutdown()` | Sends what is queued, waits for it and stops the client. |

`timestamp` is an ISO 8601 string or a `Date`; it defaults to now. `context`
may carry `source`, `session`, `device_type`, `app_version` and `os`;
`platform` is always `"server"`. Batching, retries and `debug` / `dryRun` work
as in the browser. The flush timer does not keep your process alive, so call
`shutdown()` (or `flush()`) before exiting, otherwise queued events are lost.

Keep server keys on the server. Never put one into code that ships to a browser.

## Server-side rendering

Importing the package where `window` does not exist is safe, and so is
importing `@loookin/sdk/surveys`. All calls are no-ops there (`showSurvey`
resolves to `false`), so you can call `track` from code that also runs on the server.

## Requirements

Current versions of Chrome, Edge, Firefox and Safari. For development, Node.js 22 or newer.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run size   # fails if dist/browser.js is over 5 kB or dist/surveys.js over 18 kB gzipped
```

A page for trying the browser entry by hand is in `examples/browser/index.html`,
and one for surveys in `examples/browser/surveys.html` (build first, then serve
the repository root over http). A script for the
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
