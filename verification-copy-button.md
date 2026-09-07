# Copy Button Layout Verification

The text-message row now places the copy button in the lower-right area of the message content block, beside the timestamp row, instead of in the message's upper-right corner. This keeps the action adjacent to the message footer and avoids being hidden when the conversation auto-scrolls to the newest item.

A dedicated component test now renders a real text message and verifies that the copy button appears after the message footer container, alongside the timestamp. The same test also verifies that a new item scrolls the conversation container to its newest scroll height. The desktop and mobile homepage previews rendered successfully after the change. TypeScript compilation and the full Vitest suite passed: 7 test files and 62 tests.
