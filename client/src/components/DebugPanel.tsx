/**
 * DebugPanel — On-screen debug log overlay for mobile debugging
 * 
 * Shows a small floating panel with timestamped logs and a copy button.
 * Can be toggled open/closed. Captures all debug events from the transfer system.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { Copy, Check, Bug, X, ChevronDown } from "lucide-react";

// Build version identifier — change this on each deploy to confirm code update
const BUILD_VERSION = "v2.2.0";

export interface DebugLog {
  time: string;
  msg: string;
}

// Global log store so hooks can push logs without prop drilling
const MAX_LOGS = 200;
let globalLogs: DebugLog[] = [{ time: new Date().toLocaleTimeString(), msg: `[INIT] Build ${BUILD_VERSION} loaded` }];
let listeners: Set<() => void> = new Set();

export function pushDebugLog(msg: string) {
  const entry: DebugLog = {
    time: new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    msg,
  };
  globalLogs = [...globalLogs.slice(-(MAX_LOGS - 1)), entry];
  listeners.forEach(fn => fn());
  // Also log to console for desktop debugging
  console.log(`[DBG ${entry.time}] ${msg}`);
}

function useDebugLogs() {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const listener = () => forceUpdate(n => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return globalLogs;
}

export function DebugPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const logs = useDebugLogs();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.length, isOpen]);

  const handleCopy = useCallback(async () => {
    const text = `Build: ${BUILD_VERSION}\n` + logs.map(l => `[${l.time}] ${l.msg}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for mobile browsers that don't support clipboard API
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [logs]);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-4 left-4 z-[9999] flex items-center gap-1 px-2 py-1 rounded-full bg-gray-900/80 text-white text-[10px] font-mono shadow-lg backdrop-blur-sm border border-gray-700"
      >
        <Bug className="size-3" />
        <span>{BUILD_VERSION}</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 right-4 z-[9999] max-w-md bg-gray-900/95 text-white rounded-lg shadow-2xl backdrop-blur-sm border border-gray-700 flex flex-col max-h-[50vh]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-2">
          <Bug className="size-3.5 text-emerald-400" />
          <span className="text-[11px] font-mono font-bold text-emerald-400">{BUILD_VERSION}</span>
          <span className="text-[10px] text-gray-400">({logs.length} logs)</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-[10px] font-mono transition-colors"
          >
            {copied ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
            {copied ? "Copied!" : "Copy All"}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="p-0.5 rounded hover:bg-gray-700 transition-colors"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </div>

      {/* Log content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 min-h-0">
        {logs.map((log, i) => (
          <div key={i} className="text-[10px] font-mono leading-relaxed py-0.5">
            <span className="text-gray-500">{log.time}</span>{" "}
            <span className={
              log.msg.includes("[ERR") ? "text-red-400" :
              log.msg.includes("[WARN") ? "text-amber-400" :
              log.msg.includes("[P2P") ? "text-emerald-400" :
              log.msg.includes("[WS") ? "text-blue-400" :
              log.msg.includes("[RECONNECT") ? "text-amber-300" :
              "text-gray-200"
            }>{log.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
