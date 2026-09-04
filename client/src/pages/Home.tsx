/**
 * Home Page — Quick Transfer
 * 
 * Design: Swiss Utility — Functional Minimalism
 * - Pure white background, near-black text, single teal accent
 * - Oversized monospace token as visual anchor
 * - Single-column centered layout (max-width 480px)
 * - Zero decorative elements
 */

import { TransferPanel } from "@/components/TransferPanel";
import { LangSwitch } from "@/components/LangSwitch";
import { useIsMobile } from "@/hooks/useMobile";
import { usePeerClient } from "@/hooks/usePeerClient";
import { usePeerHost } from "@/hooks/usePeerHost";
import { usePageTracking } from "@/hooks/usePageTracking";
import { useI18n } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import {
  Monitor,
  Smartphone,
  ArrowLeftRight,
  Loader2,
  AlertCircle,
  RefreshCw,
  Shield,
  ChevronDown,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Mode = "host" | "client";

/** Helper to render translation strings containing <mono>...</mono> tags */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(<mono>.*?<\/mono>)/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^<mono>(.*)<\/mono>$/);
        if (match) {
          return <span key={i} className="font-mono font-medium text-foreground">{match[1]}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/** Helper for tech detail rich text with mono spans */
function TechRichText({ text }: { text: string }) {
  const parts = text.split(/(<mono>.*?<\/mono>)/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^<mono>(.*)<\/mono>$/);
        if (match) {
          return <span key={i} className="font-mono text-muted-foreground/80">{match[1]}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export default function Home() {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [mode, setMode] = useState<Mode | null>(null);
  const [tokenInput, setTokenInput] = useState(["", "", "", ""]);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const host = usePeerHost();
  const client = usePeerClient();
  const { trackTokenEntry, trackHostConnection } = usePageTracking();

  // Set document title for SEO
  useEffect(() => {
    document.title = t("documentTitle");
  }, [t]);

  // Auto-detect mode on mount
  useEffect(() => {
    if (mode === null) {
      setMode(isMobile ? "client" : "host");
    }
  }, [isMobile, mode]);

  // Auto-start host when mode is set to host
  useEffect(() => {
    if (mode === "host" && host.status === "idle") {
      host.startHost();
    }
  }, [mode, host.status, host.startHost]);

  // Focus first input when in client mode
  useEffect(() => {
    if (mode === "client" && client.status === "idle") {
      setTimeout(() => inputRefs.current[0]?.focus(), 200);
    }
  }, [mode, client.status]);

  // Track host connection when token is generated
  useEffect(() => {
    if (host.token && mode === "host") {
      trackHostConnection(host.token);
    }
  }, [host.token, mode, trackHostConnection]);

  const handleTokenInputChange = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(-1);
    const newToken = [...tokenInput];
    newToken[index] = digit;
    setTokenInput(newToken);

    if (digit && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    if (digit && index === 3) {
      const fullToken = newToken.join("");
      if (fullToken.length === 4) {
        trackTokenEntry(fullToken);
        client.connect(fullToken);
      }
    }
  };

  const handleTokenKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !tokenInput[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
      const newToken = [...tokenInput];
      newToken[index - 1] = "";
      setTokenInput(newToken);
    }
  };

  const handleTokenPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 4);
    if (pasted.length > 0) {
      const newToken = ["", "", "", ""];
      for (let i = 0; i < pasted.length; i++) {
        newToken[i] = pasted[i];
      }
      setTokenInput(newToken);
      if (pasted.length === 4) {
        trackTokenEntry(pasted);
        client.connect(pasted);
      } else {
        inputRefs.current[pasted.length]?.focus();
      }
    }
  };

  const handleSwitchMode = () => {
    host.disconnect();
    client.disconnect();
    setTokenInput(["", "", "", ""]);
    setMode(mode === "host" ? "client" : "host");
  };

  const handleRetry = () => {
    if (mode === "host") {
      host.disconnect();
      setTimeout(() => host.startHost(), 100);
    } else {
      client.disconnect();
      setTokenInput(["", "", "", ""]);
      setTimeout(() => inputRefs.current[0]?.focus(), 200);
    }
  };

  // Connected or reconnecting state — show transfer panel
  if (
    (mode === "host" && (host.status === "connected" || host.status === "reconnecting")) ||
    (mode === "client" && (client.status === "connected" || client.status === "reconnecting"))
  ) {
    return (
      <div className="h-screen h-[100dvh] flex flex-col bg-background">
        <div className="w-full max-w-lg mx-auto flex flex-col flex-1 overflow-hidden">
          <TransferPanel
            items={mode === "host" ? host.items : client.items}
            onSendText={mode === "host" ? host.sendText : client.sendText}
            onSendFile={mode === "host" ? host.sendFile : client.sendFile}
            onDisconnect={() => {
              if (mode === "host") {
                host.disconnect();
                setTimeout(() => host.startHost(), 100);
              } else {
                client.disconnect();
                setTokenInput(["", "", "", ""]);
              }
            }}
            role={mode === "host" ? "host" : "client"}
            transportMode={mode === "host" ? host.transportMode : client.transportMode}
            isReconnecting={mode === "host" ? host.status === "reconnecting" : client.status === "reconnecting"}
            roomCode={mode === "host" ? host.token : undefined}
          />
        </div>
      </div>
    );
  }

  // Pre-connection state
  return (
    <div className="min-h-screen min-h-[100dvh] flex flex-col items-center justify-center bg-background px-5">
      <div className="w-full max-w-xs">
        {/* Language switch - top right */}
        <div className="fixed top-4 right-4 z-50">
          <LangSwitch />
        </div>

        {/* Logo / Title */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="text-center mb-14"
        >
          <div className="flex items-center justify-center gap-4 mb-4">
            <Monitor className="size-5 text-foreground/70" />
            <ArrowLeftRight className="size-3.5 text-primary" />
            <Smartphone className="size-5 text-foreground/70" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Quick Transfer</h1>
          <h2 className="text-sm text-muted-foreground mt-1.5 font-medium">{t("subtitle")}</h2>
          <p className="text-[11px] text-muted-foreground/60 mt-1 font-mono tracking-wide">t.sum.pub</p>
        </motion.div>

        <AnimatePresence mode="wait">
          {mode === "host" ? (
            <motion.div
              key="host"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="text-center"
            >
              {/* Status label */}
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-8">
                {host.status === "waiting" ? t("waitingForConnection") : host.status === "reconnecting" ? t("reconnecting") : t("initializing")}
              </p>

              {/* Token display */}
              {host.token ? (
                <div className="mb-10">
                  <div className="flex items-center justify-center gap-4">
                    {host.token.split("").map((digit, i) => (
                      <motion.span
                        key={`${host.token}-${i}`}
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: i * 0.08, duration: 0.35, ease: "easeOut" }}
                        className="text-[4.5rem] leading-none font-mono font-semibold text-foreground tabular-nums select-all"
                      >
                        {digit}
                      </motion.span>
                    ))}
                  </div>
                  
                  {/* Breathing indicator */}
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="flex items-center justify-center gap-2 mt-8"
                  >
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/40" />
                      <span className="relative inline-flex size-2 rounded-full bg-primary" />
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {t("enterCodeOnPhone")}
                    </span>
                  </motion.div>
                </div>
              ) : (
                <div className="flex justify-center mb-10 py-8">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              )}

              {/* Error */}
              {host.error && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center justify-center gap-2 text-destructive text-xs mb-6"
                >
                  <AlertCircle className="size-3.5 shrink-0" />
                  <span>{host.error}</span>
                  <button onClick={handleRetry} className="ml-1 underline underline-offset-2 hover:text-destructive/80">
                    {t("retry")}
                  </button>
                </motion.div>
              )}

              {/* Steps */}
              <div className="space-y-3 text-left">
                <Step num={1} text={<RichText text={t("step1")} />} />
                <Step num={2} text={t("step2")} />
                <Step num={3} text={t("step3")} />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="client"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25 }}
              className="text-center"
            >
              {/* Status label */}
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-8">
                {client.status === "connecting" ? t("connecting") : client.status === "reconnecting" ? t("reconnecting") : t("enterCodeFromPC")}
              </p>

              {/* Token input */}
              <div className="flex items-center justify-center gap-4 mb-10">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="relative">
                    <input
                      ref={(el) => { inputRefs.current[i] = el; }}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="one-time-code"
                      maxLength={1}
                      value={tokenInput[i]}
                      onChange={(e) => handleTokenInputChange(i, e.target.value)}
                      onKeyDown={(e) => handleTokenKeyDown(i, e)}
                      onPaste={i === 0 ? handleTokenPaste : undefined}
                      disabled={client.status === "connecting"}
                      className={cn(
                        "w-14 h-[4.5rem] text-center text-4xl font-mono font-semibold",
                        "bg-transparent outline-none transition-all duration-200",
                        "border-b-2 border-border",
                        "focus:border-primary",
                        "disabled:opacity-40",
                        tokenInput[i] && "border-foreground"
                      )}
                    />
                  </div>
                ))}
              </div>

              {/* Connecting spinner */}
              {client.status === "connecting" && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center justify-center gap-2 mb-6"
                >
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  <span className="text-xs font-mono text-muted-foreground">{t("connectingDots")}</span>
                </motion.div>
              )}

              {/* Error */}
              {client.error && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center gap-3 mb-6"
                >
                  <div className="flex items-center gap-2 text-destructive text-xs">
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span>{client.error}</span>
                  </div>
                  <button
                    onClick={handleRetry}
                    className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <RefreshCw className="size-3" />
                    {t("tryAgain")}
                  </button>
                </motion.div>
              )}

              {/* Instructions */}
              {client.status !== "connecting" && !client.error && (
                <p className="text-xs text-muted-foreground">
                  {t("lookAtPC")}
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Privacy & tech notice */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="mt-12"
        >
          <TechDetails />
        </motion.div>

        {/* Mode switcher */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-6 text-center"
        >
          <button
            onClick={handleSwitchMode}
            className="w-full max-w-[280px] min-h-14 inline-flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-2xl border-2 border-primary/25 bg-primary/5 text-sm font-semibold text-foreground shadow-sm hover:border-primary/50 hover:bg-primary/10 hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 transition-all duration-200"
          >
            <ArrowLeftRight className="size-5 text-primary" />
            {mode === "host" ? t("switchToMobile") : t("switchToPC")}
          </button>
        </motion.div>
      </div>
    </div>
  );
}

function Step({ num, text }: { num: number; text: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-sm font-mono text-muted-foreground/60 mt-0.5 shrink-0 w-5 text-right">{num}</span>
      <span className="text-sm text-muted-foreground leading-relaxed">{text}</span>
    </div>
  );
}

function TechDetails() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div className="text-center">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground/70 transition-colors"
      >
        <Shield className="size-3" />
        <span>{t("noFilesStored")}</span>
        <ChevronDown className={cn("size-3 transition-transform duration-200", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-4 mx-auto max-w-[280px] text-left space-y-2.5 text-[11px] text-muted-foreground/60 leading-relaxed">
              <div className="flex gap-2">
                <span className="font-mono text-primary/60 shrink-0 mt-px">WSS</span>
                <span><TechRichText text={t("techWSS")} /></span>
              </div>
              <div className="flex gap-2">
                <span className="font-mono text-primary/60 shrink-0 mt-px">MEM</span>
                <span>{t("techMEM")}</span>
              </div>
              <div className="flex gap-2">
                <span className="font-mono text-primary/60 shrink-0 mt-px">TTL</span>
                <span>{t("techTTL")}</span>
              </div>
              <div className="mt-3 pt-2.5 border-t border-border/30 text-[10px] font-mono text-muted-foreground/40">
                {t("techFooter")}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
