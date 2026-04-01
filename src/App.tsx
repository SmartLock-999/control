import React, { useState, useEffect } from "react";
import { AlertCircle } from "lucide-react";
import LoginScreen from "./components/LoginScreen";
import Dashboard from "./components/Dashboard";
import { supabase } from "./utils/supabaseClient";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
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

  const isSupabaseConfigured =
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY;

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
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (!isLoggedIn) return (
    <ErrorBoundary>
      <LoginScreen onLogin={(email) => { setIsLoggedIn(true); setUserEmail(email); }} />
    </ErrorBoundary>
  );

  return (
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
  );
}
