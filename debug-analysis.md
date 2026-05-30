# Debug Log Analysis - Relay Speed Issue

## Key Observations from User's Log

1. **P2P always fails**: ICE connection goes to "failed" every time. dc=connecting throughout.
   - STUN candidates are gathered but ICE connection never succeeds
   - Likely cause: router AP isolation or symmetric NAT

2. **Relay speed is 0.1-0.4 MB/s** — way too slow for LAN
   - Back-pressure threshold is 512KB but buffer stays at 530-670KB constantly
   - The back-pressure is BLOCKING for 1 second per wait (wait count increments by 100 per second)
   - This means the relay is sending ~1 chunk per second = 256KB/s ≈ 0.25 MB/s

3. **Critical Bug: Multiple concurrent sends of the SAME file**
   - Log shows "chunk 64" back-pressure wait going up to 5100 while OTHER chunks (72, 73, 74, 75, 80, 81, etc.) are also being sent
   - This means MULTIPLE sendFile/resumeFileSend loops are running concurrently for the same file!
   - Each resume creates a NEW send loop without canceling the old one
   - This causes buffer congestion (multiple loops fighting for the same WebSocket)

4. **WebSocket disconnects frequently** (every 2-3 minutes)
   - Each disconnect triggers resume for ALL pending files
   - But old send loops are still running → duplicated sends → buffer overflow → more back-pressure

5. **Back-pressure threshold too high**: 512KB threshold but WebSocket can only drain ~256KB/s through the relay server
   - The relay server is remote (Singapore), not local, so bandwidth is limited by internet speed
   - But wait — this is supposed to be LAN! The relay goes through the internet server, which is the fundamental speed bottleneck

## Root Causes

### Primary: Multiple concurrent send loops for the same file
When WS reconnects, `resumeFileSend` starts a new loop but the old loop may still be running (it got an error but the closure might not have cleaned up properly). This creates N concurrent loops all trying to send through the same WebSocket, causing massive buffer congestion.

### Secondary: Back-pressure polling interval is too slow
The relay back-pressure uses `setTimeout` with what appears to be ~1 second intervals. Even with a single sender, this limits throughput to ~256KB/s.

### Tertiary: Relay goes through remote server
The fundamental issue is that relay mode goes through the Singapore server instead of direct LAN. With P2P failing, the only path is internet relay, which is inherently slower. But it should still be 1-5 MB/s, not 0.1-0.4 MB/s.

## Fix Plan

1. **Prevent duplicate send loops**: Add a per-file send lock. If a file is already being sent, don't start another loop. Cancel old loops on WS disconnect before starting resume.
2. **Reduce back-pressure polling interval**: Change from 1s to 50ms for relay mode
3. **Lower relay buffer threshold**: From 512KB to 256KB (match chunk size)
4. **Add send cancellation on WS close**: When WS closes, immediately set a flag that stops all active send loops, THEN resume after reconnect
