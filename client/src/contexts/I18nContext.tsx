import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "zh";

const translations = {
  en: {
    // Home page - title area
    subtitle: "Send Files & Text Between Devices Instantly",

    // Host mode
    waitingForConnection: "Waiting for connection",
    initializing: "Initializing",
    enterCodeOnPhone: "Enter this code on your phone",
    step1: "Open <mono>t.sum.pub</mono> on another device",
    step2: "Enter the 4-digit code above",
    step3: "Start transferring files and text",
    retry: "Retry",

    // Client mode
    connecting: "Connecting",
    enterCodeFromPC: "Enter code from PC",
    connectingDots: "Connecting...",
    tryAgain: "Try again",
    lookAtPC: "Look at your PC screen for the 4-digit code",

    // Mode switcher
    switchToMobile: "Switch to mobile mode",
    switchToPC: "Switch to PC mode",

    // Privacy / tech details
    noFilesStored: "No files stored on server",
    techWSS: "Devices connect via <mono>WebSocket (wss://)</mono> with TLS encryption. Data is relayed in real-time through the server.",
    techMEM: "Files stream through server memory only. Zero disk writes, zero database storage. Data exists in transit, never at rest.",
    techTTL: "Sessions are ephemeral. Room destroyed on disconnect. Stale rooms auto-purge after 30 min.",
    techFooter: "Protocol: WSS · Chunk size: 64KB · No logs · No analytics on content",

    // Transfer panel
    connected: "Connected",
    end: "End",
    readyToTransfer: "Ready to transfer",
    dragFilesHere: "Drag files here or type below",
    sendTextOrAttach: "Send text or attach files below",
    dropToSend: "Drop files to send",
    typeMessage: "Type a message...",
    attachFile: "Attach file",

    // Transfer item
    copiedToClipboard: "Copied to clipboard",
    downloadStarted: "Download started",
    copyToClipboard: "Copy to clipboard",
    saveFile: "Save file",

    // 404
    pageNotFound: "Page not found",
    goBackHome: "Go back home",

    // Document title
    documentTitle: "Quick Transfer - Send Files Between Devices",
  },
  zh: {
    // 首页 - 标题区域
    subtitle: "在设备之间即时传输文件和文字",

    // Host 模式
    waitingForConnection: "等待连接",
    initializing: "初始化中",
    enterCodeOnPhone: "在手机上输入此代码",
    step1: "在另一台设备上打开 <mono>t.sum.pub</mono>",
    step2: "输入上方的4位数字代码",
    step3: "开始传输文件和文字",
    retry: "重试",

    // Client 模式
    connecting: "连接中",
    enterCodeFromPC: "输入电脑上的代码",
    connectingDots: "连接中...",
    tryAgain: "重试",
    lookAtPC: "查看电脑屏幕上的4位数字代码",

    // 模式切换
    switchToMobile: "切换到手机模式",
    switchToPC: "切换到电脑模式",

    // 隐私 / 技术细节
    noFilesStored: "服务器不存储任何文件",
    techWSS: "设备通过 <mono>WebSocket (wss://)</mono> 连接，使用 TLS 加密。数据通过服务器实时中继传输。",
    techMEM: "文件仅通过服务器内存流转。零磁盘写入，零数据库存储。数据仅在传输中存在，不会持久保存。",
    techTTL: "会话是临时的。断开连接后房间即销毁。闲置房间30分钟后自动清除。",
    techFooter: "协议: WSS · 分块大小: 64KB · 无日志 · 不分析传输内容",

    // 传输面板
    connected: "已连接",
    end: "断开",
    readyToTransfer: "准备传输",
    dragFilesHere: "拖拽文件到此处或在下方输入",
    sendTextOrAttach: "在下方发送文字或添加文件",
    dropToSend: "松开以发送文件",
    typeMessage: "输入消息...",
    attachFile: "添加文件",

    // 传输项
    copiedToClipboard: "已复制到剪贴板",
    downloadStarted: "开始下载",
    copyToClipboard: "复制到剪贴板",
    saveFile: "保存文件",

    // 404
    pageNotFound: "页面未找到",
    goBackHome: "返回首页",

    // 页面标题
    documentTitle: "Quick Transfer - 跨设备文件传输",
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = "qt-lang";

function detectLang(): Lang {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "en" || stored === "zh") return stored;
  const nav = navigator.language || "";
  return nav.startsWith("zh") ? "zh" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem(STORAGE_KEY, l);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback(
    (key: TranslationKey): string => {
      return translations[lang][key] ?? translations.en[key] ?? key;
    },
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}
