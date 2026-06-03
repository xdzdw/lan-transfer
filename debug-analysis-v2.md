# Debug Analysis v2.8.0 — 传输卡住问题

## 现象
- 电脑端（Host）发送卡在 49%（chunk 101/206）
- 手机端（Client）接收卡在 30%（chunk 61/206）
- 苹果手机锁屏导致 WS 断连 2-3 次

## 时间线分析

### 电脑端（Host - 发送方）
1. 12:21:33 开始发送 setup_13.0.1.2001w.exe (102.54MB, 206 chunks)
2. 12:22:34 进度 10% — 速度 0.17 MB/s（极慢）
3. 12:24:14 WS 断连（手机锁屏）
4. 12:24:19 Host 重连成功
5. 12:24:29 **ERR: WebSocket closed during relay at chunk 24/206**
6. 12:24:51 Client 重连 → RESUME from chunk 24
7. 12:24:51 **两个 RESUME 同时启动！**（duplicate send loop bug 仍存在？）
8. 12:25:11 进度 22% — 速度 0.52 MB/s
9. 12:25:52 进度 32% — 速度 0.34 MB/s
10. 12:26:28 Client 又断连（手机又锁屏）
11. 12:26:32 进度 42%
12. 12:27:20 Host WS 也断连
13. 12:27:20 **ERR: WebSocket closed during resume relay at chunk 101/206**
14. 12:27:22 Host 重连
15. 12:28:31 Client 重连 → **RESUME-SKIP: already has active send loop**
16. 之后再无进度更新 → **卡死在 49%**

### 手机端（Client - 接收方）
1. 12:21:23 连接成功
2. 12:24:47 WS 断连（锁屏）
3. 12:24:50 重连成功
4. 12:25:07 进度 10%（20/206 chunks）
5. 12:25:45 进度 20%（40/206 chunks）
6. 12:28:27 进度 30%（61/206 chunks）
7. 12:28:27 WS 断连（又锁屏）
8. 12:28:30 重连成功
9. 之后再无进度更新 → **卡死在 30%**

## 根本原因

### Bug 1: RESUME-SKIP 导致永久卡死
- 12:27:20 Host WS 断连时，abort 了所有活跃发送循环
- 12:27:22 Host 重连，但 Client 还没重连
- 12:28:31 Client 重连 → 触发 "peer reconnected" → 尝试 resume
- **但 RESUME-SKIP 说"already has active send loop"**
- 这说明 abort 后 activeSendAbortsRef 里的 entry 没有被清理！
- 旧的 AbortController 被 abort 了但 Map entry 还在 → 新的 resume 被跳过 → 永久卡死

### Bug 2: 两个 RESUME 同时启动
- 12:24:51 出现了两行 `[RESUME] setup_13.0.1.2001w.exe from chunk 24/206`
- 说明 per-file guard 没有完全生效

## 修复方案
1. abort 时必须从 activeSendAbortsRef Map 中 delete 该 entry
2. 或者 resume 时检查 AbortController.signal.aborted 而不是检查 Map.has()
