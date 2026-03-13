import { useI18n } from "@/contexts/I18nContext";
import { useLocation } from "wouter";

export default function NotFound() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-5">
      <div className="text-center">
        <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground mb-4">
          {t("pageNotFound")}
        </p>
        <h1 className="text-6xl font-mono font-semibold text-foreground mb-8">404</h1>
        <button
          onClick={() => setLocation("/")}
          className="text-[11px] font-mono text-primary hover:text-primary/80 transition-colors underline underline-offset-4"
        >
          {t("goBackHome")}
        </button>
      </div>
    </div>
  );
}
