# Changelog

## 0.3.0

### Added

- **Banner** surveys: a bar at the top or bottom edge (the Design's
  Position). On a wide screen the step is one row (question, answer and
  button, without description, progress bar and Back); under 640 px it
  stacks. A Banner shares the one-at-a-time slot with Popup and Modal.
- **Tooltip** surveys: a small card with a pointer next to the element the
  Design's Anchor names, on the side with room, following it on scroll,
  resize and layout changes. Not shown while the anchor is missing; closes
  without a dismissal when the anchor leaves the page. Tooltips do not
  compete with other formats; at most one per anchor.
- **Embed** surveys and `loookin.mountSurvey(key, target)`: the survey is
  drawn inside an element (or the first match of a selector) while it
  applies to the current identity, with no close button and no triggers.
  Returns a function that removes it; never throws. Its room is kept as soon
  as it applies and `survey_viewed` is sent when it is in the viewport.
- Types `SurveyTarget` and `UnmountSurvey`.
- A Tooltip waits for a visible anchor (box in the viewport, not clipped,
  `checkVisibility()`), follows an anchor the app re-rendered, and always has
  a close button.
- Surveys hide and wait while the page shows a modal dialog of its own.
- Popup, Banner, Tooltip and Embed announce their question to screen readers.
- A refused or failed `survey_viewed` is not tried again on that page for
  that user, in any format.

### Changed

- `reset()`, a change of identity and `stop()` also remove mounted embeds
  (after `reset()` and an identity change they come back when the next
  list has them).
- `showSurvey(key)` can show a Banner or a Tooltip; it resolves to `false`
  for an Embed.

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

Banner, Tooltip and Embed surveys are ignored by 0.2.0.

## 0.1.2

- No events lost when the page goes away.

## 0.1.1

- `stop()` for opting out.

## 0.1.0

- First release: browser entry with batching, retries and anonymous mode;
  Node entry; auto-tracking of page views and campaigns.
