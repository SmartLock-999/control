import React, { useState, useEffect } from "react";
import { Mail, Key, LogIn, UserPlus, AlertCircle, ShieldAlert } from "lucide-react";
import { supabase } from "../utils/supabaseClient";

const STORAGE_EMAIL    = "savedEmail";
const STORAGE_REMEMBER = "rememberMe";
const STORAGE_DEVICE_ID = "deviceId";

async function getDeviceId(): Promise<string> {
  const cached = localStorage.getItem(STORAGE_DEVICE_ID);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.textBaseline = "alphabetic";
    ctx.font = "14px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = "#069";
    ctx.fillText("SmartLock🔒", 2, 15);
    ctx.fillStyle = "rgba(102,204,0,0.7)";
    ctx.fillText("SmartLock🔒", 4, 17);
  }
  const raw = [
    canvas.toDataURL().slice(-64),
    navigator.userAgent,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    navigator.language,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency ?? "",
  ].join("|");

  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const id  = [hex.slice(0,2),hex.slice(2,4),hex.slice(4,6),
                hex.slice(6,8),hex.slice(8,10),hex.slice(10,12)].join(":").toUpperCase();
  localStorage.setItem(STORAGE_DEVICE_ID, id);
  return id;
}

export default function LoginScreen({ onLogin }: { onLogin: (email: string) => void }) {
  const [isLogin, setIsLogin]       = useState(true);
  const [email, setEmail]           = useState("");
  const [password, setPassword]     = useState("");
  const [error, setError]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [forceLoading, setForceLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  useEffect(() => {
    const saved      = localStorage.getItem(STORAGE_REMEMBER) === "true";
    const savedEmail = localStorage.getItem(STORAGE_EMAIL) || "";
    setRememberMe(saved);
    if (saved && savedEmail) setEmail(savedEmail);
  }, []);

  /* ── 儲存記住我 ── */
  const saveRememberMe = (em: string) => {
    if (rememberMe) {
      localStorage.setItem(STORAGE_REMEMBER, "true");
      localStorage.setItem(STORAGE_EMAIL, em);
    } else {
      localStorage.removeItem(STORAGE_REMEMBER);
      localStorage.removeItem(STORAGE_EMAIL);
    }
  };

  /* ── 一般登入 ── */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const deviceId = await getDeviceId();

      if (isLogin) {
        const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
        if (authError) throw new Error("帳號或密碼錯誤");

        const { data: emailData, error: emailError } = await supabase
          .from("registered_emails").select("mac").eq("email", email).single();
        if (emailError) throw new Error("查詢帳號資料失敗");

        if (emailData.mac && emailData.mac !== deviceId) {
          await supabase.auth.signOut();
          throw new Error("裝置驗證失敗，此帳號已綁定其他裝置（可使用強制登入）");
        }
        if (!emailData.mac) {
          await supabase.from("registered_emails").update({ mac: deviceId }).eq("email", email);
        }

        saveRememberMe(email);
        onLogin(email);
      } else {
        const { error: authError } = await supabase.auth.signUp({ email, password });
        if (authError) throw authError;
        const { error: insertError } = await supabase
          .from("registered_emails").insert([{ email, mac: null }]);
        if (insertError && !insertError.message.includes("duplicate")) throw insertError;
        alert("註冊成功！請登入。");
        setIsLogin(true);
      }
    } catch (err: any) {
      setError(err.message || "發生錯誤");
    } finally {
      setLoading(false);
    }
  };

  /* ── 強制登入 ────────────────────────────────────────────────────────
     順序：先 Auth 登入（驗密碼）→ 登入後才能查 registered_emails（RLS）
     → 確認 email 欄位存在 → 清 MAC → 綁目前裝置 → 自動登入            */
  const handleForceLogin = async () => {
    if (!email || !password) { setError("請先輸入帳號與密碼"); return; }
    setError("");
    setForceLoading(true);
    try {
      const deviceId = await getDeviceId();

      // 1. 先用 Supabase Auth 驗證帳密（未登入前 RLS 無法查資料表）
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        // Auth 失敗代表帳號不存在或密碼錯誤
        throw new Error("帳號或密碼錯誤");
      }

      // 2. 登入後才查 registered_emails，確認 email 欄位存在
      const { data: regData, error: regError } = await supabase
        .from("registered_emails")
        .select("email, mac")
        .eq("email", email)
        .single();

      if (regError || !regData) {
        await supabase.auth.signOut();
        throw new Error("此帳號尚未完成系統註冊，請聯繫管理員");
      }

      // 3. 清空 MAC（解除舊裝置綁定）
      const { error: clearError } = await supabase
        .from("registered_emails")
        .update({ mac: null })
        .eq("email", email);
      if (clearError) throw new Error("清除裝置綁定失敗，請稍後再試");

      // 4. 重新綁定目前裝置
      await supabase
        .from("registered_emails")
        .update({ mac: deviceId })
        .eq("email", email);

      saveRememberMe(email);
      onLogin(email);
    } catch (err: any) {
      await supabase.auth.signOut().catch(() => {});
      setError(err.message || "強制登入失敗");
    } finally {
      setForceLoading(false);
    }
  };

  const anyLoading = loading || forceLoading;

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div className="w-full max-w-md bg-slate-900 rounded-2xl p-8 shadow-2xl border border-slate-800">
        <div className="flex justify-center mb-6">
          <div className="bg-blue-600 p-4 rounded-full">
            {isLogin ? <LogIn className="w-8 h-8 text-white" /> : <UserPlus className="w-8 h-8 text-white" />}
          </div>
        </div>
        <h1 className="text-2xl font-bold text-center text-white mb-2">Smart Lock</h1>
        <p className="text-slate-400 text-center mb-8">
          {isLogin ? "登入您的控制面板" : "註冊新帳號"}
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/50 rounded-xl flex items-start gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-snug">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">電子郵件</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl py-3 pl-10 pr-4 text-white focus:outline-none focus:border-blue-500 transition-colors"
                required autoComplete="email" disabled={anyLoading} />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">密碼</label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500" />
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl py-3 pl-10 pr-4 text-white focus:outline-none focus:border-blue-500 transition-colors"
                required minLength={6} autoComplete="current-password" disabled={anyLoading} />
            </div>
          </div>

          {isLogin && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 text-blue-600 bg-slate-800 border-slate-700 rounded focus:ring-blue-500"
                disabled={anyLoading} />
              <span className="text-sm text-slate-400">記住我（下次自動登入）</span>
            </label>
          )}

          {/* 一般登入 */}
          <button type="submit" disabled={anyLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors">
            {loading
              ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              : isLogin
              ? <><LogIn className="w-5 h-5" /> 登入系統</>
              : <><UserPlus className="w-5 h-5" /> 註冊帳號</>}
          </button>

          {/* 強制登入（僅登入模式顯示） */}
          {isLogin && (
            <button
              type="button"
              onClick={handleForceLogin}
              disabled={anyLoading}
              className="w-full bg-orange-600/20 hover:bg-orange-600/30 disabled:opacity-50 border border-orange-600/50 text-orange-400 font-semibold rounded-xl py-3 flex items-center justify-center gap-2 transition-colors"
            >
              {forceLoading
                ? <div className="w-5 h-5 border-2 border-orange-400/30 border-t-orange-400 rounded-full animate-spin" />
                : <><ShieldAlert className="w-5 h-5" /> 強制登入</>}
            </button>
          )}
        </form>

        {/* 強制登入說明 */}
        {isLogin && (
          <p className="mt-3 text-xs text-slate-600 text-center leading-relaxed">
            強制登入會解除舊裝置綁定，並重新綁定目前裝置
          </p>
        )}

        <div className="mt-4 text-center">
          <button onClick={() => { setIsLogin(!isLogin); setError(""); }}
            disabled={anyLoading}
            className="text-slate-400 hover:text-white text-sm transition-colors disabled:opacity-50">
            {isLogin ? "還沒有帳號？點此註冊" : "已有帳號？點此登入"}
          </button>
        </div>
      </div>
    </div>
  );
}
