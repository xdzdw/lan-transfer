import { useI18n, type Lang } from "@/contexts/I18nContext";
import { cn } from "@/lib/utils";

export function LangSwitch({ className }: { className?: string }) {
  const { lang, setLang } = useI18n();

  const toggle = () => {
    setLang(lang === "en" ? "zh" : "en");
  };

  return (
    <button
      onClick={toggle}
      className={cn(
        "text-[11px] font-mono text-muted-foreground/60 hover:text-muted-foreground transition-colors",
        className
      )}
    >
      {lang === "en" ? "中文" : "EN"}
    </button>
  );
}
