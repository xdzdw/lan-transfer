# Region Screenshot and Black-Frame Verification

The screenshot flow now captures a still PNG, opens an in-app region selector, and lets the user drag a rectangle before sending. The selected rectangle is mapped from the displayed image size back to the original screenshot pixels and cropped with Canvas.

Capture requests include Chromium-compatible hints to exclude the current browser tab when possible, keep surface switching available, and show the cursor. The selected frame is sampled for near-black output. If the selected window returns a black frame, the flow stops before sending and shows a bilingual explanation recommending a browser tab or full-screen selection and disabling protected content.

Verification passed: TypeScript compilation, 9 Vitest files with 70 tests, and production build. Actual screen/window capture requires a user gesture and browser/OS permission, so the picker and protected-window behavior must be manually verified in a supported browser.

The selector interaction model now has tests for reverse-direction drags, empty selection, and the minimum confirmation size. The current sandbox browser could not establish a second connected device, so real `getDisplayMedia` permission and protected-window behavior remain a manual verification step on the user's desktop browser. Full validation currently passes: 10 test files and 73 tests, plus the production build.

Pointer-release fix: selection now tracks an explicit dragging state, uses the final pointer-up coordinate, releases pointer capture, and stops updating after release. This covers mouse and touch pointer events, including a drag ending at the lower-right corner. The interaction model tests now cover final-coordinate capture and drag completion. Validation passes: TypeScript, 10 test files, 74 tests.

The selector now uses a pointer-event state reducer. A pointer-up event records its own final coordinate, sets `isDragging` to false, releases pointer capture, and ignores later pointer moves until the next pointer-down. Tests simulate down → move → bottom-right up and confirm the final selection remains stable after release.

A rendered jsdom test now simulates the selector surface pointer-down, pointer-move, and bottom-right pointer-up events. It verifies the real confirmation button changes from disabled to enabled, remains enabled after a later move, and releases pointer capture. Vitest now collects TSX tests explicitly. Final validation passes: 11 test files and 75 tests, TypeScript, and production build.
