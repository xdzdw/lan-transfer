import {
  RELAY_MAX_FILE_BYTES,
  RelayLimitError,
  isRelayFileAllowed,
  type RelayFileMeta,
} from "@shared/relayLimits";
import {
  getSelectedTransportPath,
  refreshSelectedPath,
  sendViaTransport,
  type TransportMode,
  type WebRTCTransport,
} from "./webrtc";

function isWebSocketOpen(ws: WebSocket | null): ws is WebSocket {
  // WebSocket.OPEN is 1 in browsers. The numeric fallback keeps this helper
  // usable in non-browser unit tests without weakening its browser behavior.
  const open = typeof WebSocket === "undefined" ? 1 : WebSocket.OPEN;
  return !!ws && ws.readyState === open;
}

function assertRelayFileAllowed(
  meta: RelayFileMeta,
  maxBytes = RELAY_MAX_FILE_BYTES
): void {
  if (!isRelayFileAllowed(meta, maxBytes)) {
    throw new RelayLimitError(maxBytes, meta.id);
  }
}

/**
 * Record metadata with the signaling server. `relay-register` is intentionally
 * not a file-protocol message and the server keeps it only for relay guarding;
 * it is never forwarded to the peer.
 */
export function registerRelayFile(
  ws: WebSocket | null,
  meta: RelayFileMeta
): void {
  if (!isWebSocketOpen(ws)) return;
  ws.send(JSON.stringify({ type: "relay-register", meta }));
}

/**
 * Get the route that an *open* data channel currently uses for file bytes.
 * Unknown selected-pair information deliberately maps to `relay`, which makes
 * policy checks fail closed for ordinary oversized files.
 */
export function getFileTransportMode(
  transport: WebRTCTransport | null
): Extract<TransportMode, "p2p" | "turn" | "relay"> {
  if (!transport?.dataChannel || transport.dataChannel.readyState !== "open") {
    return "relay";
  }

  const selectedPath = getSelectedTransportPath(transport);
  if (selectedPath === "p2p") {
    transport.mode = "p2p";
    return "p2p";
  }
  if (selectedPath === "turn") {
    transport.mode = "turn";
    return "turn";
  }

  // A stats-only browser may resolve the selected pair asynchronously. Start a
  // fresh lookup for later chunks, but never allow the current unknown route to
  // be treated as direct.
  transport.mode = "relay";
  void refreshSelectedPath(transport);
  return "relay";
}

/**
 * Check a file before emitting its file metadata or chunks. A direct selected
 * pair is unrestricted. TURN, WebSocket and unknown routes are restricted for
 * ordinary files; screenshots/images are exempt via the shared policy.
 */
export async function prepareFileTransfer(
  transport: WebRTCTransport | null,
  ws: WebSocket | null,
  meta: RelayFileMeta
): Promise<void> {
  const dataChannelOpen = transport?.dataChannel?.readyState === "open";

  if (dataChannelOpen && transport) {
    // This performs an authoritative selected-pair stats lookup where the
    // standard getSelectedCandidatePair API is absent. Do this before deciding
    // whether an oversized ordinary file may start.
    await refreshSelectedPath(transport);
  }

  if (getFileTransportMode(transport) !== "p2p") {
    assertRelayFileAllowed(meta);
  }

  // Register only after the client-side decision succeeded, so a rejected file
  // never leaves metadata that could authorise unrelated future bytes.
  registerRelayFile(ws, meta);
}

/**
 * Send one file-protocol payload (file-meta, chunk, or file-complete).
 *
 * The raw transport remains usable for text messages. This wrapper is the only
 * file path and installs a pre-relay check so an oversized direct transfer can
 * never fall back to WebSocket after a DataChannel send error or close.
 */
export function sendFileViaTransport(
  transport: WebRTCTransport | null,
  ws: WebSocket | null,
  data: string | ArrayBuffer,
  meta: RelayFileMeta
): Extract<TransportMode, "p2p" | "turn" | "relay"> {
  const attemptedMode = getFileTransportMode(transport);

  // Before a raw send, reject known TURN/WS/unknown routes. A direct channel is
  // allowed regardless of file size, but its failure is guarded again below.
  if (attemptedMode !== "p2p") {
    assertRelayFileAllowed(meta);
  }

  const rawMode = sendViaTransport(transport, ws, data, () => {
    // This is deliberately unconditional with respect to the previous route:
    // the fallback itself is relay. Thus a large direct transfer is blocked if
    // its DataChannel throws, closes, or otherwise falls through to WebSocket.
    assertRelayFileAllowed(meta);
  });

  if (rawMode === "relay") {
    // No WS may have been open for the raw callback to run. Treat the failed
    // route as relay as well so callers do not silently continue an oversized
    // file and accidentally retry it over the server later.
    assertRelayFileAllowed(meta);
    return "relay";
  }

  // `sendViaTransport` calls all DataChannel success "p2p". Preserve the
  // selected route here so UI can distinguish a direct channel from TURN.
  return attemptedMode === "turn" ? "turn" : "p2p";
}
