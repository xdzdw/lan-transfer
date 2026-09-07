# Screenshot Send/Receive Verification

The conversation panel now exposes a screenshot capture button next to the existing file attachment button. It uses the browser Screen Capture API (`getDisplayMedia`) to capture one still frame as a PNG, immediately stops the capture tracks, and sends the PNG through the existing reliable file-transfer protocol.

Screenshot metadata is propagated through `file-meta`, including reconnection/resume, so no new server relay protocol is required. Both sender and receiver render screenshot-specific rows. The sender sees an immediate preview; the receiver sees the assembled preview and a Save screenshot action after completion.

Unsupported browsers, denied permissions, and user cancellation are handled with bilingual toast messages. TypeScript compilation, production build, and the full Vitest suite passed: 9 test files and 66 tests. Desktop and mobile base-page previews rendered successfully. Actual screen capture requires a user gesture and browser permission, so it cannot be exercised automatically in the sandbox preview.

## Manual browser verification

On a supported desktop browser, open the connected conversation, click **Capture screenshot**, choose a screen or window in the browser permission picker, and confirm that the sender sees a screenshot preview and transfer progress. On the second device, confirm that the received item becomes a screenshot preview with a **Save screenshot** action. On a mobile browser, use the same control if the browser exposes `getDisplayMedia`; otherwise the interface reports that screen capture is unsupported without interrupting file or text transfer.
