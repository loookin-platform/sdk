# Tab close test

Checks that events still in the queue are sent when the page goes away. The
unit tests cannot cover this: it depends on what each browser does with a
request started while a tab is closing.

Every round loads a page that tracks 20 events and then makes the page go
away. Twenty is on purpose: at 30 the SDK sends the queue at once and nothing
would be left to measure. A local server on another origin stands in for the
ingest and counts what arrives. At least 95 % must arrive.

Nothing leaves your machine and no workspace or key is needed.

## Chromium, Chrome, Firefox, WebKit

```bash
npx playwright install chromium firefox webkit
```

```bash
npm run test:tabclose
```

Each browser is tried three ways: the tab is closed, the tab is killed without
asking the page, and the tab navigates to another address. The installed Google
Chrome is included when there is one.

WebKit is only measured for navigating away. Playwright's WebKit destroys a
closed page without `pagehide` or `visibilitychange`, so a closed tab tells
nothing about Safari there.

## Safari

macOS only, and it needs you:

```bash
npm run test:tabclose:safari
```

Safari opens a tab every 13 seconds. Close each one right away with Cmd+W. A
round counts only when the tab was closed before the SDK's own 10 second send
could have delivered the queue; the last line shows the result.

Close leftover `localhost:4100` tabs before you start.

## Not covered

Closing a whole window, quitting the browser and mobile browsers.

## Results

| Date | Version | Chromium | Chrome | Firefox | Safari |
|---|---|---|---|---|---|
| 2026-11-21 | 0.1.1 | 300/300 | 300/300 | 300/300 | 80/80 (4 rounds counted) |
