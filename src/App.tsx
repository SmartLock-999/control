import React, { useState, useEffect } from "react";
import { AlertCircle } from "lucide-react";
import LoginScreen from "./components/LoginScreen";
import Dashboard from "./components/Dashboard";
import { supabase } from "./utils/supabaseClient";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type EBProps = { children: React.ReactNode };
type EBState = { error: Error | null };
class ErrorBoundary extends React.Component<EBProps, EBState> {
  readonly props: EBProps;
  state: EBState = { error: null };

  constructor(props: EBProps) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
          <div className="max-w-md w-full bg-slate-900 border border-red-500/50 rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center gap-3 text-red-500 mb-4">
              <AlertCircle className="w-8 h-8" />
              <h2 className="text-xl font-bold">頁面發生錯誤</h2>
            </div>
            <p className="text-slate-300 mb-4">
              請重新整理頁面；若仍發生，請清除本站快取/Service Worker 後再試。
            </p>
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-xs text-slate-400 overflow-x-auto">
              {this.state.error.message}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userEmail, setUserEmail]   = useState<string>("");
  const [loading, setLoading]       = useState(true);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);

  const isSupabaseConfigured =
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY;
  const isStandalone = typeof window !== "undefined"
    && (window.matchMedia("(display-mode: standalone)").matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
  const isIosSafari = typeof navigator !== "undefined"
    && /iphone|ipad|ipod/i.test(navigator.userAgent)
    && /safari/i.test(navigator.userAgent)
    && !/crios|fxios|edgios/i.test(navigator.userAgent);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstallPrompt(null);
      setShowInstallGuide(false);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) { setLoading(false); return; }

    const rememberMe = localStorage.getItem("rememberMe") === "true";

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user?.email && rememberMe) {
        // 有 session 且曾勾選記住我 → 直接自動登入
        setIsLoggedIn(true);
        setUserEmail(session.user.email);
      } else if (session && !rememberMe) {
        // 有 session 但未勾選記住我 → 清除，回登入頁
        supabase.auth.signOut();
      }
      setLoading(false);
    });

    // onAuthStateChange 只處理明確的 SIGNED_OUT，
    // SIGNED_IN 交給 LoginScreen 的 onLogin callback 處理，
    // 避免自動 session 恢復時繞過 rememberMe 檢查
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setIsLoggedIn(false);
        setUserEmail("");
      }
    });

    return () => subscription.unsubscribe();
  }, [isSupabaseConfigured]);

  const handleInstall = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      setInstallPrompt(null);
      return;
    }
    if (isIosSafari && !isStandalone) {
      setShowInstallGuide(true);
    }
  };

  const installButton = (!isStandalone && (installPrompt || isIosSafari)) ? (
    <button
      onClick={() => void handleInstall()}
      className="fixed right-4 bottom-4 z-[100000] rounded-full bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xl active:bg-blue-700"
    >
      安裝到首頁
    </button>
  ) : null;

  const installGuide = showInstallGuide ? (
    <div className="fixed inset-0 z-[100001] bg-black/70 p-4 flex items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5">
        <h3 className="mb-2 text-base font-bold text-white">安裝到首頁</h3>
        <p className="mb-4 text-sm leading-6 text-slate-300">
          iPhone 或 iPad 請點瀏覽器的分享按鈕，再選「加入主畫面」。
        </p>
        <button
          onClick={() => setShowInstallGuide(false)}
          className="w-full rounded-xl border border-slate-600 py-2.5 text-sm text-slate-200 active:bg-slate-800"
        >
          關閉
        </button>
      </div>
    </div>
  ) : null;

  if (!isSupabaseConfigured) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4">
      <div className="max-w-md w-full bg-slate-900 border border-red-500/50 rounded-2xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 text-red-500 mb-4">
          <AlertCircle className="w-8 h-8" />
          <h2 className="text-xl font-bold">缺少 Supabase 設定</h2>
        </div>
        <p className="text-slate-300 mb-4">請在專案的環境變數中設定 Supabase 資訊。</p>
        <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 font-mono text-sm text-slate-400">
          <p>VITE_SUPABASE_URL="您的_URL"</p>
          <p>VITE_SUPABASE_ANON_KEY="您的_KEY"</p>
        </div>
      </div>
    </div>
  );

  if (loading) return (
    <>
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
      {installButton}
      {installGuide}
    </>
  );

  if (!isLoggedIn) return (
    <>
      <ErrorBoundary>
        <LoginScreen onLogin={(email) => { setIsLoggedIn(true); setUserEmail(email); }} />
      </ErrorBoundary>
      {installButton}
      {installGuide}
    </>
  );

  return (
    <>
      <ErrorBoundary>
        <Dashboard
          email={userEmail}
          onLogout={() => {
            localStorage.removeItem("rememberMe");
            localStorage.removeItem("savedEmail");
            setIsLoggedIn(false);
            setUserEmail("");
          }}
        />
      </ErrorBoundary>
      {installButton}
      {installGuide}
    </>
  );
}
