# Debug Notes

## Problem Analysis

The core issue: WebRTC requires **direct peer-to-peer connectivity** between the PC and phone. 
When both devices are on the same LAN, WebRTC with STUN servers should work.
However, when the website is hosted on a remote server (manus.space), the WebSocket signaling 
goes through the remote server, but WebRTC still tries to establish a direct connection.

Key insight: The user's scenario is:
1. PC opens t.sum.pub (hosted remotely) → connects to remote WS signaling server
2. Phone opens t.sum.pub (hosted remotely) → connects to remote WS signaling server
3. Signaling works fine (both connect to same remote server)
4. WebRTC tries to establish P2P connection between PC and phone on LAN
5. STUN servers may not work well behind certain NATs, and there's no TURN server as fallback

## Solution

Since the primary use case is LAN transfer, we should use a **pure WebSocket relay** approach 
instead of WebRTC. The signaling server becomes the data relay:
- Both devices connect to the same server via WebSocket
- All data (text + file chunks) flows through the WebSocket server
- No WebRTC needed, no NAT traversal issues
- Works reliably as long as both devices can reach the server

This is simpler and more reliable for the use case. The tradeoff is slightly higher latency 
(data goes through server instead of P2P), but for a file transfer tool this is acceptable 
and much more reliable.
