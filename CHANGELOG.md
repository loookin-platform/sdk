# Changelog

## 0.2.0

### Added

- In-app surveys. Surveys of the types **Popup** and **Modal** from your
  workspace show up in your app after `identify`, with no new deploy. On by
  default; `init({ surveys: false })` turns them off, and
  `init({ surveys: { language } })` sends the visitor's preferred language.
- `loookin.showSurvey(key)` shows a survey by its key without its triggers.
  Resolves to whether it was shown; never rejects.
- New entry `@loookin/sdk/surveys` (`dist/surveys.js`, under 18 kB gzipped):
  the renderer, loaded by the browser entry with a dynamic import only when
  the workspace has a survey to show. The browser entry stays under 5 kB.
- Triggers evaluated in the browser: page load with URL rules (also on
  in-app navigation, with "hide on pages that don't match"), an event from
  `track`, element view, click, time on page and exit intent.
- The survey is drawn in a shadow root on its own element, styled by the
  survey's Design, with keyboard support, a focus trap for Modal, and a
  "Test" label for test runs. Two tabs never show the same survey. It is
  shown only after the server accepted the view, in the top layer where the
  browser has one; Escape always closes a Modal and a failed send always
  offers Close.
- Web fonts are opt-in: `init({ surveys: { webFonts: true } })`. By default
  a survey uses the page's font and nothing is loaded from a font host.
- In anonymous mode the SDK remembers in `localStorage` which surveys the
  device was shown, closed or answered.

### Changed

- `reset()` and a change of identity also close an open survey; `stop()`
  also removes the listeners the surveys added.
- Auto-tracking and surveys share one navigation hook. With surveys on and
  a survey to show, the SDK listens for `popstate` and `hashchange` and wraps
  `history.pushState` and `history.replaceState`.
- Shorter debug messages.

Banner, Tooltip and Embed surveys are ignored by this version.

## 0.1.2

- No events lost when the page goes away.

## 0.1.1

- `stop()` for opting out.

## 0.1.0

- First release: browser entry with batching, retries and anonymous mode;
  Node entry; auto-tracking of page views and campaigns.
