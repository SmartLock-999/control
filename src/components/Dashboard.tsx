import React, { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  MapContainer, TileLayer, Circle, Marker,
  useMap, useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import {
  Crosshair, ChevronLeft, ChevronRight,
  LogOut, Settings, Share2, Trash2, X, MapPin, UserMinus, Users, Pencil, Clock, Timer,
} from "lucide-react";
import { supabase } from "../utils/supabaseClient";
import mqtt from "mqtt";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/* ─── 自訂圖示 ─── */
const gpsIcon = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid white;
    border-radius:50%;box-shadow:0 0 0 5px rgba(59,130,246,0.3);
    animation:gpsPulse 2s infinite ease-in-out"></div>
  <style>@keyframes gpsPulse{0%,100%{box-shadow:0 0 0 5px rgba(59,130,246,0.3)}
    50%{box-shadow:0 0 0 10px rgba(59,130,246,0.05)}}</style>`,
  iconSize: [16, 16], iconAnchor: [8, 8],
});
const pendingIcon = L.divIcon({
  className: "",
  html: `<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z"
      fill="#f97316" stroke="white" stroke-width="2"/>
    <circle cx="12" cy="12" r="4" fill="white"/></svg>`,
  iconSize: [24, 32], iconAnchor: [12, 32],
});
const savedIcon = L.divIcon({
  className: "",
  html: `<svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z"
      fill="#22c55e" stroke="white" stroke-width="2"/>
    <circle cx="12" cy="12" r="4" fill="white"/></svg>`,
  iconSize: [24, 32], iconAnchor: [12, 32],
});

/* ─── 型別 ─── */
interface DeviceCredential {
  id: string;
  device_name: string;
  device_name_initial?: string | null;
  device_name_custom?: string | null;
  mqtt_user?: string;
  mqtt_pass?: string;
  server_no?: number | null;
  share_from?: string | null;
  share_count: number;
  notify?: string | null;   // 被分享者要求刪除時填入，格式："{user_id}要求刪除設備"
}
interface SharedWithItem {
  id: string;           // device_credentials.id of the shared row
  user_id: string;      // 被分享者的 email
}
/* notify 來源兩路：
   "owner"  = 主帳號那筆（share_from IS NULL）的 notify 有值
   "share"  = 分享出去的 row（share_from = 主帳號）的 notify 有值（保底路）*/
interface NotifyItem {
  id: string;                    // device_credentials.id
  source: "owner" | "share";
  device_name: string;
  device_name_custom?: string | null;
  device_name_initial?: string | null;
  mqtt_user?: string;
  mqtt_pass?: string;
  notify: string;                // 原始 notify 值
  share_count: number;           // 僅 owner row 有意義
  requesterEmail: string;        // 從 notify 解析出的要求者 email
}
interface SavedLocation {
  id: string;
  label: string;
  position: [number, number];
}
// 定時設定（存 localStorage）
interface SchedDef {
  type: "weekday" | "date";
  weekMask?: number;   // bit0=週一…bit6=週日
  dates?: string[];    // ["YYYY-MM-DD"]
  hour: number;
  minute: number;
}
interface TimerCfg {
  mode: "periodic" | "schedule";
  intervalSec?: number;   // periodic 用，最短 60 秒
  periodicStartedAt?: number; // periodic 開始時間（ms）
  schedule?: SchedDef;    // schedule 用（送到 ESP32）
  active: boolean;
}

/* ─── 地圖子元件 ─── */
function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (target) map.flyTo(target, 18, { duration: 1.0 }); }, [target, map]);
  return null;
}
function MapClickHandler({ onMapClick }: { onMapClick: (p: [number, number]) => void }) {
  useMapEvents({ click: (e) => onMapClick([e.latlng.lat, e.latlng.lng]) });
  return null;
}
function PortalModal({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}

/* 顯示名稱優先順序：device_name_custom → device_name_initial → device_name → mqtt_user */
function displayName(d: DeviceCredential | null): string {
  if (!d) return "";
  return d.device_name_custom?.trim()
    || d.device_name_initial?.trim()
    || d.device_name?.trim()
    || d.mqtt_user
    || "";
}

const MAX_SHARES = 5;
const DEFAULT_CENTER: [number, number] = [22.6273, 120.3014];

/* ─── MQTT 伺服器對照表（從 DB 的 mqtt_list 載入，不寫死）─── */
// mqtt_list 是全局設定表，不需以 user_id 篩選
const MQTT_FALLBACK: Record<number, string> = {}; // DB 載入前暫為空

/** 依 device 的 server_no 從傳入的 mqttList 取得 Broker URL；找不到時回傳 null
 *  mqtt_list.url 可以是完整 URL 或純 hostname，本函式統一補齊格式：
 *    hostname only  → wss://<hostname>:8884/mqtt
 *    已有 protocol  → 原樣使用                                          */
function getBrokerUrl(
  device: DeviceCredential | null,
  mqttList: Record<number, string>
): string | null {
  if (!device) return null;
  const no: number = (device.server_no != null && device.server_no > 0)
    ? device.server_no
    : 1;
  const raw = mqttList[no];
  if (!raw) return null;
  // 已有 protocol（wss:// 或 ws://）→ 直接使用
  if (/^wss?:\/\//i.test(raw)) return raw;
  // 純 hostname → 補齊成完整 WSS URL
  return `wss://${raw}:8884/mqtt`;
}

export default function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [devices, setDevices]               = useState<DeviceCredential[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceCredential | null>(null);
  const [loading, setLoading]               = useState(true);
  // 伺服器連線狀態：key = server_no
  const [serverStatusMap, setServerStatusMap] = useState<Record<number, "Online"|"Offline"|"Connecting">>({});
  // 設備在線狀態：key = device.id（依 retain status topic 判斷）
  const [deviceOnlineMap, setDeviceOnlineMap] = useState<Record<string, boolean|null>>({});
  const [showCredentials, setShowCredentials]   = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting]           = useState(false);

  // MQTT 伺服器對照表（從 DB 載入）
  const [mqttList, setMqttList] = useState<Record<number, string>>(MQTT_FALLBACK);

  // 地圖
  const [isStreetView, setIsStreetView]       = useState(false);
  const [userPosition, setUserPosition]       = useState<[number, number] | null>(null);
  const [flyTarget, setFlyTarget]             = useState<[number, number] | null>(null);
  const [gpsLoading, setGpsLoading]           = useState(false);
  const [gpsError, setGpsError]               = useState<string | null>(null);
  const [pendingLocation, setPendingLocation] = useState<[number, number] | null>(null);
  const [savedLocations, setSavedLocations]   = useState<SavedLocation[]>([]);
  const [activeLocIdx, setActiveLocIdx]       = useState(0);
  const [locationsLoaded, setLocationsLoaded] = useState(false);

  // 設備改名
  const [editingName, setEditingName]   = useState(false);
  const [newDeviceName, setNewDeviceName] = useState("");

  // 手動控制按壓提示
  const [triggeredAction, setTriggeredAction] = useState<string | null>(null);
  // 觸發 toast 訊息
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // 按鈕自訂名稱（依設備分開存 localStorage）
  const [btnLabels, setBtnLabels] = useState<Record<string, string>>({});
  // 長按改名 modal
  const [editingBtn, setEditingBtn]   = useState<string | null>(null); // action key
  const [editBtnName, setEditBtnName] = useState("");
  const longPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // 地點命名
  const [showNameModal, setShowNameModal] = useState(false);
  const [pendingName, setPendingName]     = useState("");

  // 分享設備
  const [showShareModal, setShowShareModal]   = useState(false);
  const [shareEmail, setShareEmail]           = useState("");
  const [shareLoading, setShareLoading]       = useState(false);
  const [shareError, setShareError]           = useState("");

  // 管理分享（主人撤銷）
  const [showManageModal, setShowManageModal] = useState(false);
  const [sharedWithList, setSharedWithList]   = useState<SharedWithItem[]>([]);
  const [manageLoading, setManageLoading]     = useState(false);

  // 離開分享（被分享者）
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leaveLoading, setLeaveLoading]         = useState(false);

  // 刪除通知（主帳號收到被分享者要求刪除的通知）
  const [notifyList, setNotifyList] = useState<NotifyItem[]>([]);
  const [showNotifyModal, setShowNotifyModal] = useState(false);
  const [notifyProcessing, setNotifyProcessing] = useState(false);

  // 返回鍵二次確認
  const backPressCount = React.useRef(0);
  const backPressTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // 設定面板（齒輪展開）
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);

  // 儲存各 server_no 的 MQTT client，供 handleControl 發布指令
  const mqttClientsRef = React.useRef<Record<number, mqtt.MqttClient>>({});

  // ── 定時觸發 state ──
  // timerConfigs 依設備獨立，key 格式：btnTimers_{deviceId}
  const timerStorageKey = useCallback((dev: DeviceCredential | null) =>
    dev ? `btnTimers_${dev.id}` : "btnTimers_nodev"
  , []);
  const btnLabelStorageKey = useCallback((dev: DeviceCredential | null) =>
    dev ? `btnLabels_${dev.id}` : "btnLabels_nodev"
  , []);
  const lastSelectedDeviceKey = useCallback((userEmail: string) =>
    `last_selected_device_${userEmail.trim().toLowerCase()}`, []);

  const [timerConfigs, setTimerConfigs] = useState<Record<string, TimerCfg>>(() => {
    // 初始載入：等待 selectedDevice 確定後由 useEffect 重載，先給空物件
    return {};
  });
  const [showBtnMenu, setShowBtnMenu]               = useState<string | null>(null);
  const [showTimerModal, setShowTimerModal]         = useState<string | null>(null);
  // periodic 編輯
  const [editTimerSec, setEditTimerSec]   = useState(60);
  // schedule 編輯
  const [editTimerMode, setEditTimerMode]     = useState<"periodic"|"schedule">("periodic");
  const [editSchedType, setEditSchedType]     = useState<"weekday"|"date">("weekday");
  const [editSchedDays, setEditSchedDays]     = useState<number[]>([1,2,3,4,5]); // 1=Mon…7=Sun
  const [editSchedDates, setEditSchedDates]   = useState<string[]>([]);
  const [editSchedHour, setEditSchedHour]     = useState(8);
  const [editSchedMin, setEditSchedMin]       = useState(0);
  const selectedDeviceRef = React.useRef<DeviceCredential | null>(null);
  const mqttListRef       = React.useRef<Record<number, string>>({});
  const readBtnLabelsForDevice = useCallback((dev: DeviceCredential | null): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem(btnLabelStorageKey(dev)) || "{}"); }
    catch { return {}; }
  }, [btnLabelStorageKey]);
  const setActiveDevice = useCallback((device: DeviceCredential | null) => {
    selectedDeviceRef.current = device;
    try {
      if (device?.id) localStorage.setItem(lastSelectedDeviceKey(email), device.id);
    } catch {}
    setSelectedDevice(device);
  }, [email, lastSelectedDeviceKey]);

  const isOwnDevice    = !!(selectedDevice && !selectedDevice.share_from);
  // count 本身就代表剩餘次數（每次分享 -1）
  const shareRemaining = isOwnDevice ? (selectedDevice?.share_count ?? 0) : null;

  /* ── 取得設備 + 載入 MQTT 清單（同步完成，避免時序問題）── */
  const fetchDevices = useCallback(async () => {
    try {
      // 1. 同時查詢兩張表
      const [devResult, mqttResult] = await Promise.all([
        supabase
          .from("device_credentials")
          .select("id, device_name, device_name_initial, device_name_custom, mqtt_user, mqtt_pass, server_no, share_from, count, notify")
          .eq("user_id", email),
        supabase
          .from("mqtt_list")
          .select("server_no, url"),
      ]);

      // 2. 建立 server_no → url 對照表（不依賴 mqtt_list.user_id）
      const newMqttList: Record<number, string> = {};
      if (!mqttResult.error && mqttResult.data) {
        mqttResult.data.forEach((row: { server_no: number; url: string }) => {
          if (row.server_no != null && row.url) newMqttList[row.server_no] = row.url;
        });
      } else {
        console.warn("[mqtt_list] 查詢失敗:", mqttResult.error?.message);
      }
      setMqttList(newMqttList);

      // 3. 處理設備資料
      if (devResult.error) throw devResult.error;
      const rows: any[] = devResult.data || [];

      // 建立 owner count 查找表
      const ownerCountMap: Record<string, number> = {};
      rows.forEach((r) => {
        if (!r.share_from) {
          ownerCountMap[`${r.mqtt_user}|${r.mqtt_pass}|${r.device_name}`] =
            parseInt(String(r.count ?? 0), 10);
        }
      });

      const mapped: DeviceCredential[] = rows.map((r) => ({
        id: r.id,
        device_name: r.device_name,
        device_name_initial: r.device_name_initial ?? null,
        device_name_custom: r.device_name_custom ?? null,
        mqtt_user: r.mqtt_user,
        mqtt_pass: r.mqtt_pass,
        server_no: r.server_no ?? null,
        share_from: r.share_from ?? null,
        share_count: ownerCountMap[`${r.mqtt_user}|${r.mqtt_pass}|${r.device_name}`]
          ?? parseInt(String(r.count ?? 0), 10),
        notify: r.notify ?? null,
      }));

      // 4. 自動補寫 device_name_initial（只寫一次，不覆蓋既有值）
      const needsInit = mapped.filter((d) => !d.device_name_initial && d.device_name);
      if (needsInit.length > 0) {
        await Promise.all(
          needsInit.map((d) =>
            supabase
              .from("device_credentials")
              .update({ device_name_initial: d.device_name })
              .eq("id", d.id)
          )
        );
        needsInit.forEach((d) => { d.device_name_initial = d.device_name; });
      }

      setDevices(mapped);

      // 5. 兩路掃描 notify，建立 NotifyItem 清單
      //    路一：主帳號 owner row（share_from IS NULL）的 notify 有值
      //    路二：主帳號分享出去的 row（share_from = email）的 notify 有值（保底）
      const parseEmail = (n: string) => n.trim().split(/\s+/)[0] ?? "";
      const notifyItems: NotifyItem[] = [];
      const seenKey = new Set<string>(); // 去重：requesterEmail|device_name

      // 路一
      mapped
        .filter((d) => !d.share_from && d.notify)
        .forEach((d) => {
          const req = parseEmail(d.notify!);
          const key = `${req}|${d.device_name}`;
          if (req && !seenKey.has(key)) {
            seenKey.add(key);
            notifyItems.push({
              id: d.id, source: "owner",
              device_name: d.device_name,
              device_name_custom: d.device_name_custom,
              device_name_initial: d.device_name_initial,
              mqtt_user: d.mqtt_user, mqtt_pass: d.mqtt_pass,
              notify: d.notify!, share_count: d.share_count,
              requesterEmail: req,
            });
          }
        });

      // 路二：查詢分享出去的 row（share_from = email）的 notify（需額外查詢）
      const { data: shareRows } = await supabase
        .from("device_credentials")
        .select("id, device_name, device_name_custom, device_name_initial, mqtt_user, mqtt_pass, notify, user_id")
        .eq("share_from", email)
        .not("notify", "is", null);
      (shareRows ?? []).forEach((r: any) => {
        const req = parseEmail(r.notify ?? "");
        const key = `${req}|${r.device_name}`;
        if (req && !seenKey.has(key)) {
          seenKey.add(key);
          notifyItems.push({
            id: r.id, source: "share",
            device_name: r.device_name,
            device_name_custom: r.device_name_custom ?? null,
            device_name_initial: r.device_name_initial ?? null,
            mqtt_user: r.mqtt_user, mqtt_pass: r.mqtt_pass,
            notify: r.notify, share_count: 0,
            requesterEmail: req,
          });
        }
      });

      setNotifyList(notifyItems);
      if (notifyItems.length > 0) setShowNotifyModal(true);
    } catch (err) { console.error("fetchDevices:", err); }
    finally { setLoading(false); }
  }, [email]);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  useEffect(() => {
    if (!devices.length) {
      setSelectedDevice(null);
      return;
    }
    const storedId = (() => {
      try { return localStorage.getItem(lastSelectedDeviceKey(email)) || ""; }
      catch { return ""; }
    })();
    const currentId = selectedDevice?.id ?? "";
    const next =
      (currentId ? devices.find((d) => d.id === currentId) : null)
      || (storedId ? devices.find((d) => d.id === storedId) : null)
      || devices[0]
      || null;
    if (!next) return;
    if (next.id !== currentId) setActiveDevice(next);
  }, [devices, email, lastSelectedDeviceKey, setActiveDevice]);

  useEffect(() => {
    const id = selectedDevice?.id;
    try {
      if (id) localStorage.setItem(lastSelectedDeviceKey(email), id);
    } catch {}
  }, [email, lastSelectedDeviceKey, selectedDevice?.id]);

  /* ── refs 同步（讓 timer callback 永遠讀到最新值）── */
  useEffect(() => { selectedDeviceRef.current = selectedDevice; }, [selectedDevice]);
  useEffect(() => { mqttListRef.current = mqttList; },           [mqttList]);
  useEffect(() => {
    setBtnLabels(readBtnLabelsForDevice(selectedDevice));
  }, [readBtnLabelsForDevice, selectedDevice?.id]);

  /* ── 依目前設備載入該設備設定 ── */
  useEffect(() => {
    setShowBtnMenu(null);
    setShowTimerModal(null);
    setEditingBtn(null);
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }

    if (selectedDevice?.share_from) {
      // 分享設備：先從對應的 owner row localStorage 讀取排程（避免畫面閃空）
      // owner row 與此分享設備同 mqtt_user + device_name，但 share_from IS NULL
      const dev = selectedDevice;
      const ownerRow = devices.find(
        d => !d.share_from &&
             d.mqtt_user === dev.mqtt_user &&
             d.device_name === dev.device_name
      );
      if (ownerRow) {
        // owner row 的 localStorage 已有排程設定，直接顯示（常駐）
        let ownerConfigs: Record<string, TimerCfg> = {};
        try { ownerConfigs = JSON.parse(localStorage.getItem(`btnTimers_${ownerRow.id}`) || "{}"); } catch {}
        setTimerConfigs(ownerConfigs);
      } else {
        // owner row 不在本帳號下（純被分享者），從臨時 key 讀取前次 ESP32 回報的設定
        let tmpConfigs: Record<string, TimerCfg> = {};
        try { tmpConfigs = JSON.parse(localStorage.getItem(`btnTimers_tmp_${dev.mqtt_user}_${dev.device_name}`) || "{}"); } catch {}
        if (Object.keys(tmpConfigs).length > 0) setTimerConfigs(tmpConfigs);
        // 若臨時 key 也沒資料，保持現有 state 不清空，等 ESP32 回報
      }
      // 向 ESP32 請求最新設定，回報後由 MQTT message handler 更新（不清空 state，避免閃爍）
      const no = (dev.server_no != null && dev.server_no > 0) ? dev.server_no : 1;
      const client = mqttClientsRef.current[no];
      if (client?.connected && dev.mqtt_user && dev.device_name) {
        const cfgTopic = `device/${dev.mqtt_user}/${dev.device_name}/config`;
        client.publish(cfgTopic, JSON.stringify({ action: "get_periodic" }), { qos: 1 });
        setTimeout(() => {
          client.publish(cfgTopic, JSON.stringify({ action: "get_schedule" }), { qos: 1 });
        }, 200);
      }
      return;
    }

    const key = timerStorageKey(selectedDevice);
    let configs: Record<string, TimerCfg> = {};
    try { configs = JSON.parse(localStorage.getItem(key) || "{}"); } catch {}
    setTimerConfigs(configs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id, selectedDevice?.share_from, devices]);

  /* ── 登入後從 locations 資料表讀取已儲存的定位點 ── */
  useEffect(() => {
    if (locationsLoaded) return;
    const load = async () => {
      try {
        const { data: userData } = await supabase.auth.getUser();
        const authUserId = userData?.user?.id;
        if (!authUserId) return;
        const { data, error } = await supabase
          .from("locations")
          .select("id, name, lat, lng")
          .eq("user_id", authUserId)
          .order("name", { ascending: true });
        if (error) { console.warn("[locations] 讀取失敗:", error.message); return; }
        const locs: SavedLocation[] = (data ?? [])
          .filter((r: any) => r.lat != null && r.lng != null)
          .map((r: any) => ({
            id: String(r.id),
            label: r.name ?? "未命名",
            position: [Number(r.lat), Number(r.lng)] as [number, number],
          }));
        if (locs.length) {
          setSavedLocations(locs);
          setActiveLocIdx(0);
        }
      } catch (err) { console.warn("[locations] 讀取例外:", err); }
      finally { setLocationsLoaded(true); }
    };
    void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationsLoaded]);

  /* ── 登入後自動上傳 GPS 定位點至 positions，之後每 3 分鐘重複 ── */
  useEffect(() => {
    if (!navigator.geolocation) return;

    const uploadPosition = async (pos: GeolocationPosition) => {
      try {
        const { data: userData } = await supabase.auth.getUser();
        const authUserId = userData?.user?.id;
        if (!authUserId) return;
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        const accuracy_m = pos.coords.accuracy ?? null;
        await supabase.from("positions").insert({
          user_id: authUserId,
          lat,
          lng,
          accuracy_m,
          captured_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn("[positions] 上傳失敗:", err);
      }
    };

    const doUpload = () => {
      navigator.geolocation.getCurrentPosition(
        uploadPosition,
        (err) => console.warn("[positions] 取得位置失敗:", err.message),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    };

    // 立即上傳一次
    doUpload();
    // 每 3 分鐘重複
    const timer = window.setInterval(doUpload, 3 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── 開啟頁面自動 GPS 定位 ── */
  useEffect(() => {
    if (!navigator.geolocation) return;
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserPosition(c);
        setFlyTarget(c);
        setGpsLoading(false);
      },
      () => setGpsLoading(false),   // 靜默失敗，不顯示錯誤（自動定位）
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []); // 只在 mount 時執行一次

  /* ── Android 返回鍵二次確認 ── */
  useEffect(() => {
    const handleBackButton = () => {
      if (backPressCount.current === 0) {
        backPressCount.current = 1;
        setToastMsg("再按一次返回鍵跳出程式");
        if (backPressTimer.current) clearTimeout(backPressTimer.current);
        backPressTimer.current = setTimeout(() => {
          backPressCount.current = 0;
          setToastMsg(null);
        }, 2500);
        // 重新 push state 讓下次還能攔截
        window.history.pushState(null, "", window.location.href);
      } else {
        // 第二次按 → 真正離開
        if (backPressTimer.current) clearTimeout(backPressTimer.current);
        window.history.go(-2);
      }
    };
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("popstate", handleBackButton);
    return () => {
      window.removeEventListener("popstate", handleBackButton);
      if (backPressTimer.current) clearTimeout(backPressTimer.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── MQTT：伺服器層連線（偵測伺服器是否在線）+ 設備層 retain 訂閱（偵測設備在線）──
     架構：
       ① 每個 server_no 建立一條長連線（用 owner 設備憑證），監聽 connect/close 判斷伺服器狀態
       ② 連上後訂閱所有屬於該伺服器的設備 status topic（retain），即時判斷設備在線
     優點：
       ● 伺服器狀態和設備狀態分開顯示
       ● 不需要輪詢，retain 訊息連上就立刻知道
  ── */
  useEffect(() => {
    if (!devices.length || !Object.keys(mqttList).length) return;

    // 依 server_no 分組，每個 server_no 只建一條連線
    const serverGroups: Record<number, DeviceCredential[]> = {};
    devices.forEach((d) => {
      if (!d.mqtt_user || !d.mqtt_pass) return;
      const no = d.server_no != null && d.server_no > 0 ? d.server_no : 1;
      if (!mqttList[no]) return;
      if (!serverGroups[no]) serverGroups[no] = [];
      serverGroups[no].push(d);
    });

    const cleanups: (() => void)[] = [];

    Object.entries(serverGroups).forEach(([noStr, devs]) => {
      const no = Number(noStr);
      const brokerUrl = getBrokerUrl(devs[0], mqttList);
      if (!brokerUrl) return;

      // 用第一台 owner 設備憑證建連線（分享設備用 owner 憑證）
      const cred = devs.find((d) => !d.share_from) ?? devs[0];
      let isActive = true;

      setServerStatusMap((prev) => ({ ...prev, [no]: "Connecting" }));

      const client = mqtt.connect(brokerUrl, {
        username: cred.mqtt_user!,
        password: cred.mqtt_pass!,
        clientId: `web_srv${no}_${Math.random().toString(36).slice(2, 8)}`,
        reconnectPeriod: 5000,
        keepalive: 30,
        clean: true,
      });

      // 儲存 client 供 handleControl 發布指令使用
      mqttClientsRef.current[no] = client;

      client.on("connect", () => {
        if (!isActive) return;
        setServerStatusMap((prev) => ({ ...prev, [no]: "Online" }));

        // status 訂閱（逐設備 row，含 share row）
        const statusTopics = devs
          .filter((d) => d.mqtt_user && d.device_name)
          .map((d) => `device/${d.mqtt_user}/${d.device_name}/status`);

        // cfg_report 訂閱：ESP32 主動回報設定時使用，依實體設備去重
        const cfgReportTopics: string[] = [];
        const seenCfg = new Set<string>();
        devs.filter(d => d.mqtt_user && d.device_name).forEach(d => {
          const k = `${d.mqtt_user}|${d.device_name}`;
          if (!seenCfg.has(k)) {
            seenCfg.add(k);
            cfgReportTopics.push(`device/${d.mqtt_user}/${d.device_name}/cfg_report`);
          }
        });

        const allTopics = [...statusTopics, ...cfgReportTopics];
        if (allTopics.length) client.subscribe(allTopics, { qos: 0 });

        // 連線後查詢 ESP32 目前的循環 + 排程設定
        // 依實體設備（mqtt_user + device_name）去重，owner / share row 共用同一台設備
        setTimeout(() => {
          const seen = new Set<string>();
          devs.filter(d => d.mqtt_user && d.device_name).forEach(d => {
            const key = `${d.mqtt_user}|${d.device_name}`;
            if (seen.has(key)) return;
            seen.add(key);
            const cfgTopic = `device/${d.mqtt_user}/${d.device_name}/config`;
            client.publish(cfgTopic, JSON.stringify({ action: "get_periodic" }), { qos: 1 });
            client.publish(cfgTopic, JSON.stringify({ action: "get_schedule" }), { qos: 1 });
          });
        }, 1500);
      });

      client.on("message", (topic, payload) => {
        if (!isActive) return;
        const text = new TextDecoder().decode(payload).trim();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch {}

        // ── ESP32 回報循環設定（periodic_cfg）→ 同步 state + localStorage ──
        if (parsed?.type === "periodic_cfg" && Array.isArray(parsed.periodics)) {
          // 找到所有符合此 topic 的設備（owner row + share row 都要）
          const matchedDevs = devs.filter(d =>
            d.mqtt_user && d.device_name &&
            topic.startsWith(`device/${d.mqtt_user}/${d.device_name}/`)
          );
          if (!matchedDevs.length) return;

          // localStorage 以 owner row 為基底（share row 不寫 localStorage）
          const ownerDev = matchedDevs.find(d => !d.share_from);
          let stored: Record<string, TimerCfg> = {};
          if (ownerDev) {
            try { stored = JSON.parse(localStorage.getItem(`btnTimers_${ownerDev.id}`) || "{}"); } catch {}
          } else {
            // 純被分享者：以目前顯示中的 timerConfigs 為基底，避免其他類型設定被清掉
            try { stored = JSON.parse(JSON.stringify(
              selectedDeviceRef.current && matchedDevs.some(d => d.id === selectedDeviceRef.current?.id)
                ? Object.fromEntries(Object.entries(
                    JSON.parse(localStorage.getItem(`btnTimers_tmp_${matchedDevs[0].mqtt_user}_${matchedDevs[0].device_name}`) || "{}") as [string, TimerCfg][]
                  ))
                : {}
            )); } catch {}
          }

          (parsed.periodics as any[]).forEach((p: any) => {
            const a: string = p.target;
            if (p.active && p.intervalSec >= 60) {
              stored[a] = {
                mode: "periodic",
                intervalSec: p.intervalSec,
                periodicStartedAt: stored[a]?.mode === "periodic" ? stored[a].periodicStartedAt : Date.now(),
                active: true,
              };
            } else {
              if (stored[a]?.mode === "periodic") delete stored[a];
            }
          });

          if (ownerDev) {
            try { localStorage.setItem(`btnTimers_${ownerDev.id}`, JSON.stringify(stored)); } catch {}
          } else {
            // 純被分享者：暫存到臨時 key（以 mqtt_user+device_name 識別）
            try { localStorage.setItem(`btnTimers_tmp_${matchedDevs[0].mqtt_user}_${matchedDevs[0].device_name}`, JSON.stringify(stored)); } catch {}
          }

          // 目前選中的設備屬於同一實體設備（owner 或 share row）→ 更新顯示
          if (matchedDevs.some(d => d.id === selectedDeviceRef.current?.id)) {
            setTimerConfigs({ ...stored });
          }
          return;
        }

        // ── ESP32 回報排程設定（schedule_cfg）→ 同步 state + localStorage ──
        if (parsed?.type === "schedule_cfg" && Array.isArray(parsed.schedules)) {
          // 找到所有符合此 topic 的設備（owner row + share row 都要）
          const matchedDevs = devs.filter(d =>
            d.mqtt_user && d.device_name &&
            topic.startsWith(`device/${d.mqtt_user}/${d.device_name}/`)
          );
          if (!matchedDevs.length) return;

          const ownerDev = matchedDevs.find(d => !d.share_from);
          let stored: Record<string, TimerCfg> = {};
          if (ownerDev) {
            try { stored = JSON.parse(localStorage.getItem(`btnTimers_${ownerDev.id}`) || "{}"); } catch {}
          } else {
            // 純被分享者：從臨時 key 讀取（含先前 periodic_cfg 合併的結果）
            try { stored = JSON.parse(localStorage.getItem(`btnTimers_tmp_${matchedDevs[0].mqtt_user}_${matchedDevs[0].device_name}`) || "{}"); } catch {}
          }

          (parsed.schedules as any[]).forEach((s: any) => {
            const a: string = s.target;
            if (s.active) {
              stored[a] = {
                mode: "schedule", active: true,
                schedule: {
                  type:     s.stype === 1 || s.stype === "date" ? "date" : "weekday",
                  weekMask: s.weekMask,
                  dates:    typeof s.dates === "string" ? s.dates.split(",").filter(Boolean) : (s.dates ?? []),
                  hour: s.hour, minute: s.minute,
                },
              };
            } else {
              if (stored[a]?.mode === "schedule") delete stored[a];
            }
          });

          if (ownerDev) {
            try { localStorage.setItem(`btnTimers_${ownerDev.id}`, JSON.stringify(stored)); } catch {}
          } else {
            // 純被分享者：同步更新臨時 key
            try { localStorage.setItem(`btnTimers_tmp_${matchedDevs[0].mqtt_user}_${matchedDevs[0].device_name}`, JSON.stringify(stored)); } catch {}
          }

          // 目前選中的設備屬於同一實體設備（owner 或 share row）→ 更新顯示
          if (matchedDevs.some(d => d.id === selectedDeviceRef.current?.id)) {
            setTimerConfigs({ ...stored });
          }
          return;
        }
        const action = parsed?.action ?? text;
        const online = String(action).toLowerCase() !== "offline"
                    && String(action).toLowerCase() !== "disconnected";
        devs.forEach((d) => {
          if (!d.mqtt_user || !d.device_name) return;
          if (topic === `device/${d.mqtt_user}/${d.device_name}/status`) {
            setDeviceOnlineMap((prev) => ({ ...prev, [d.id]: online }));
          }
        });
      });

      client.on("error", () => {
        if (!isActive) return;
        // error 不代表伺服器離線（可能只是 auth 問題），維持 Connecting
      });

      client.on("close", () => {
        if (!isActive) return;
        setServerStatusMap((prev) => ({ ...prev, [no]: "Offline" }));
      });

      client.on("reconnect", () => {
        if (!isActive) return;
        setServerStatusMap((prev) => ({ ...prev, [no]: "Connecting" }));
      });

      cleanups.push(() => {
        isActive = false;
        delete mqttClientsRef.current[no];
        try { client.end(true); } catch {}
      });
    });

    return () => { cleanups.forEach((fn) => fn()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.map((d) => d.id).join(","), JSON.stringify(mqttList)]);

  /* ── 登出 ── */
  const handleLogout = async () => {
    try {
      await supabase.from("registered_emails").update({ mac: null }).eq("email", email);
      await supabase.auth.signOut();
      onLogout();
    } catch (err) { console.error(err); }
  };

  /* ── 重置 ── */
  const handleReset = async () => {
    setResetting(true);
    try {
      const { error } = await supabase.from("device_credentials").delete().eq("user_id", email);
      if (error) throw error;
      setDevices([]); setSelectedDevice(null); setShowResetConfirm(false);
      alert("重置完成");
    } catch { alert("重置失敗"); }
    finally { setResetting(false); }
  };

  /* ── 按鈕點擊：periodic/schedule 模式下直接手動觸發，其餘由 ESP32 排程執行 ── */
  const handleBtnClick = useCallback((action: string) => {
    handleControl(action);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 送設定到 ESP32 config topic（periodic / schedule 兩路分開）── */
  const sendScheduleToDevice = useCallback((action: string, cfg: TimerCfg | null) => {
    const dev  = selectedDeviceRef.current;
    const list = mqttListRef.current;
    if (!dev?.mqtt_user || !dev?.device_name) return;
    const no     = (dev.server_no != null && dev.server_no > 0) ? dev.server_no : 1;
    const client = mqttClientsRef.current[no];
    const brokerUrl = getBrokerUrl(dev, list);
    if (!client?.connected && !brokerUrl) return;
    if (!client?.connected) return;
    const cfgTopic = `device/${dev.mqtt_user}/${dev.device_name}/config`;

    if (!cfg || !cfg.active) {
      client.publish(cfgTopic, JSON.stringify({ action: "set_periodic", target: action, active: false }), { qos: 1 });
      setTimeout(() => client.publish(cfgTopic, JSON.stringify({ action: "set_schedule", target: action, active: false }), { qos: 1 }), 200);
      return;
    }
    if (cfg.mode === "periodic") {
      const intervalSec = Math.max(60, cfg.intervalSec ?? 60);
      client.publish(cfgTopic, JSON.stringify({ action: "set_periodic", target: action, active: true, intervalSec }), { qos: 1 });
      setTimeout(() => client.publish(cfgTopic, JSON.stringify({ action: "set_schedule", target: action, active: false }), { qos: 1 }), 200);
      return;
    }
    if (cfg.mode === "schedule" && cfg.schedule) {
      const s = cfg.schedule;
      const payload: Record<string, unknown> = { action: "set_schedule", target: action, active: true, stype: s.type, hour: s.hour, minute: s.minute };
      if (s.type === "weekday") { payload.weekMask = s.weekMask ?? 31; }
      else                      { payload.dates    = (s.dates ?? []).join(","); }
      client.publish(cfgTopic, JSON.stringify(payload), { qos: 1 });
      setTimeout(() => client.publish(cfgTopic, JSON.stringify({ action: "set_periodic", target: action, active: false }), { qos: 1 }), 200);
    }
  }, []);

  /* ── 存定時設定（localStorage 設備專屬 + 精準管理此 action 計時器）── */
  const saveTimerConfig = useCallback((action: string, cfg: TimerCfg | null) => {
    const dev = selectedDeviceRef.current;
    if (dev?.share_from) {
      setToastMsg("共享設備不可設定循環/定時觸發");
      setTimeout(() => setToastMsg(null), 2500);
      return;
    }
    const key = timerStorageKey(selectedDeviceRef.current);
    setTimerConfigs(prev => {
      const updated = { ...prev };
      if (cfg === null) { delete updated[action]; } else { updated[action] = cfg; }
      try { localStorage.setItem(key, JSON.stringify(updated)); } catch {}
      return updated;
    });
    sendScheduleToDevice(action, cfg);
  }, [timerStorageKey, sendScheduleToDevice]);

  /* ── 控制 ── */
  const handleControl = (action: string) => {
    const device = selectedDeviceRef.current ?? selectedDevice ?? devices[0] ?? null;
    if (!device?.mqtt_user || !device?.device_name) { return; }
    if (selectedDeviceRef.current?.id !== device.id || selectedDevice?.id !== device.id) {
      setActiveDevice(device);
    }
    const no = (device.server_no != null && device.server_no > 0)
      ? device.server_no : 1;
    const client = mqttClientsRef.current[no];
    const brokerUrl = getBrokerUrl(device, mqttList);
    if (!client?.connected && !brokerUrl) {
      alert(`設備「${displayName(device)}」的伺服器（server_no=${device.server_no ?? 1}）URL 未設定，請確認 mqtt_list 資料表`);
      return;
    }
    if (!client || !client.connected) {
      alert("伺服器尚未連線，請稍候再試");
      return;
    }
    const pin = action === "open" ? "D4" : action === "stop" ? "D18" : "D19";
    const topic = `device/${device.mqtt_user}/${device.device_name}/command`;
    const payload = JSON.stringify({ action, pin, ts: Math.floor(Date.now() / 1000) });
    client.publish(topic, payload, { qos: 1 });
    // 按壓動畫
    setTriggeredAction(action);
    setTimeout(() => setTriggeredAction(null), 1200);
    // 震動提示（短震）
    if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
    // Toast 提示
    const defaultLabels: Record<string, string> = { open: "開", stop: "停", down: "關" };
    const label = readBtnLabelsForDevice(device)[action] || defaultLabels[action] || action;
    setToastMsg(`已觸發「${label}」`);
    setTimeout(() => setToastMsg(null), 2500);
  };

  /* ── 按鈕長按 → 打開選單 ── */
  const handleBtnLongPress = (action: string) => {
    if (navigator.vibrate) navigator.vibrate(50);
    setShowBtnMenu(action);
  };
  const confirmBtnRename = () => {
    if (!editingBtn) return;
    const dev = selectedDeviceRef.current;
    const defaultLabels: Record<string, string> = { open: "開", stop: "停", down: "關" };
    const trimmed = editBtnName.trim();
    const updated = { ...btnLabels };
    if (!trimmed || trimmed === defaultLabels[editingBtn]) {
      delete updated[editingBtn]; // 清空 = 還原預設
    } else {
      updated[editingBtn] = trimmed;
    }
    setBtnLabels(updated);
    try { localStorage.setItem(btnLabelStorageKey(dev), JSON.stringify(updated)); } catch {}
    setEditingBtn(null);
  };

  const formatIntervalLabel = (sec: number) =>
    sec >= 3600 ? `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`
    : sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60 > 0 ? `${sec % 60}s` : ""}`
    : `${sec}s`;

  /* ── 手動 GPS ── */
  const handleLocate = () => {
    if (!navigator.geolocation) { setGpsError("不支援 GPS"); return; }
    setGpsLoading(true); setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserPosition(c); setFlyTarget(c); setGpsError(null); setGpsLoading(false);
      },
      (err) => {
        setGpsLoading(false);
        setGpsError(err.code === err.PERMISSION_DENIED ? "定位被拒，請在瀏覽器設定允許" : "無法取得位置");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  /* ── 分享設備 ──────────────────────────────────────────────────────
     邏輯：直接 INSERT，讓資料庫回報錯誤（不做跨帳號 RLS 查詢）         */
  const handleShare = async () => {
    if (!selectedDevice || !isOwnDevice) return;
    const target = shareEmail.trim().toLowerCase();
    if (!target) { setShareError("請輸入 Email"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) { setShareError("Email 格式不正確"); return; }
    if (target === email.toLowerCase()) { setShareError("不能分享給自己"); return; }
    if ((shareRemaining ?? 0) <= 0) { setShareError("分享次數已用盡"); return; }

    setShareLoading(true);
    setShareError("");
    try {
      // 1. 取得 owner row
      const { data: ownerRow, error: ownerErr } = await supabase
        .from("device_credentials")
        .select("id, count")
        .eq("user_id", email)
        .eq("device_name", selectedDevice.device_name)
        .eq("mqtt_user", selectedDevice.mqtt_user ?? "")
        .is("share_from", null)
        .single();
      if (ownerErr || !ownerRow) throw new Error("找不到設備資料，請重新整理後再試");

      const currentCount = parseInt(String(ownerRow.count ?? 0), 10);

      // 2. 先查對方是否已有此設備（含 share_from 欄位判斷是否已分享）
      const { data: existingRow } = await supabase
        .from("device_credentials")
        .select("id, share_from")
        .eq("user_id", target)
        .eq("device_name", selectedDevice.device_name)
        .eq("mqtt_user", selectedDevice.mqtt_user ?? "")
        .maybeSingle();

      if (existingRow) {
        // 已有 share_from → 代表已經分享過，禁止重複
        if (existingRow.share_from) {
          throw new Error(`「${displayName(selectedDevice)}」已分享給 ${target}，請勿重複分享`);
        }
        // share_from 為 null → 對方是此設備的 owner，不能分享給他
        throw new Error(`${target} 本身已是此設備的擁有者，無法再分享`);
      } else {
        // 全新分享 → INSERT
        const { error: insertErr } = await supabase
          .from("device_credentials")
          .insert({
            user_id:     target,
            device_name: selectedDevice.device_name,
            mqtt_user:   selectedDevice.mqtt_user,
            mqtt_pass:   selectedDevice.mqtt_pass,
            server_no:   selectedDevice.server_no ?? null,
            share_from:  email,
            count:       currentCount - 1,
          });
        if (insertErr) {
          console.error("INSERT error:", insertErr);
          throw new Error(`新增分享資料失敗：[${insertErr.code}] ${insertErr.message}`);
        }
      }

      // 3. UPDATE owner count - 1
      await supabase
        .from("device_credentials")
        .update({ count: currentCount - 1 })
        .eq("id", ownerRow.id);

      await fetchDevices();
      setShowShareModal(false);
      setShareEmail("");
      alert(`已成功分享「${displayName(selectedDevice)}」給 ${target}`);
    } catch (err: any) {
      setShareError(err.message || "分享失敗");
    } finally {
      setShareLoading(false);
    }
  };

  /* ── 地點導航 ── */
  const nav = (dir: 1 | -1) => {
    if (!savedLocations.length) return;
    const i = (activeLocIdx + dir + savedLocations.length) % savedLocations.length;
    setActiveLocIdx(i); setFlyTarget(savedLocations[i].position);
  };

  /* ── 新增地點命名 ── */
  const openNameModal = () => {
    if (!pendingLocation) return;
    setPendingName(`地點 ${savedLocations.length + 1}`);
    setShowNameModal(true);
  };
  const confirmAddLocation = async () => {
    if (!pendingLocation) return;
    const label = pendingName.trim() || `地點 ${savedLocations.length + 1}`;
    // 快照座標，避免 state 清空後遺失
    const lat = pendingLocation[0];
    const lng = pendingLocation[1];

    // 先更新本地 state（UI 即時反應）
    const localId = Date.now().toString();
    const newEntry: SavedLocation = { id: localId, label, position: [lat, lng] };
    const upd = [...savedLocations, newEntry];
    setSavedLocations(upd);
    setActiveLocIdx(upd.length - 1);
    setPendingLocation(null);
    setPendingName("");
    setShowNameModal(false);

    // 上傳至 Supabase locations 資料表
    // locations.user_id 是 UUID 外鍵→auth.users(id)，必須用 getUser() 取得
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user?.id) {
        console.warn("[locations] 無法取得 auth user id:", userErr?.message);
        return;
      }
      const authUserId = userData.user.id;

      // radius 為 NOT NULL，給預設值 0
      const { data: inserted, error } = await supabase
        .from("locations")
        .insert({ user_id: authUserId, name: label, lat, lng, radius: 0 })
        .select("id")
        .single();
      if (!error && inserted?.id) {
        // 用 DB 回傳的 UUID 替換本地暫時 id
        setSavedLocations((prev) =>
          prev.map((loc) => loc.id === localId ? { ...loc, id: inserted.id } : loc)
        );
      } else if (error) {
        console.warn("[locations] INSERT 失敗:", error.message);
      }
    } catch (err) {
      console.warn("[locations] 上傳例外:", err);
    }
  };

  /* ── 刪除設備 ──────────────────────────────────────────────────────────
     主帳號刪除：同時刪除所有 share_from = email 的分享 row（連帶清除）
     分享來的設備：不直接刪除，改為在主帳號 owner row 的 notify 欄位寫入要求，
                   並顯示訊息提示使用者。                                  */
  const handleDeleteDevice = async (dev: DeviceCredential) => {
    if (!dev.share_from) {
      // 主帳號刪除
      if (!confirm(`刪除「${displayName(dev)}」？此操作將同時移除所有分享。`)) return;
      try {
        await supabase
          .from("device_credentials")
          .delete()
          .eq("share_from", email)
          .eq("device_name", dev.device_name)
          .eq("mqtt_user", dev.mqtt_user ?? "");
        await supabase
          .from("device_credentials")
          .delete()
          .eq("id", dev.id);
      } catch (err: any) {
        alert("刪除失敗：" + (err.message || err));
        return;
      }
      const upd = devices.filter((d) => d.id !== dev.id);
      setDevices(upd);
      if (selectedDevice?.id === dev.id) setSelectedDevice(upd[0] ?? null);
    } else {
      // 被分享者：雙路寫入 notify，不直接刪除
      if (!confirm(`確定要通知主帳號刪除「${displayName(dev)}」的分享？`)) return;
      const notifyVal = `${email} "要求刪除設備"`;
      try {
        const { error: directErr } = await supabase
          .from("device_credentials")
          .update({ notify: notifyVal })
          .eq("user_id", dev.share_from)
          .eq("device_name", dev.device_name)
          .eq("mqtt_user", dev.mqtt_user ?? "")
          .eq("mqtt_pass", dev.mqtt_pass ?? "")
          .is("share_from", null);
        if (directErr) {
          const { error: rpcErr } = await supabase.rpc("request_delete_share", {
            p_owner_email: dev.share_from,
            p_requester_id: email,
            p_device_name: dev.device_name,
            p_mqtt_user: dev.mqtt_user ?? "",
          });
          if (rpcErr) console.warn("[notify owner]", rpcErr.message);
        }

        // 路二：直接更新被分享者自己那筆 share row 的 notify（保底）
        const { error: selfErr } = await supabase
          .from("device_credentials")
          .update({ notify: notifyVal })
          .eq("id", dev.id);
        if (selfErr) console.warn("[notify 路二 self]", selfErr.message);

        alert("已通知主帳號刪除，待主帳號確認後將移除分享。");
      } catch (err: any) {
        alert("通知失敗：" + (err.message || err));
      }
    }
  };

  /* ── 主帳號確認刪除通知 ──────────────────────────────────────────────
     source="owner"：解析 requesterEmail，刪除其 share row，清空 owner notify，count+1
     source="share" ：直接刪除該 share row（id），不需解析                */
  const handleConfirmNotify = async (item: NotifyItem) => {
    setNotifyProcessing(true);
    try {
      if (item.source === "owner") {
        // 1a. 刪除被分享者的 share row
        const { error: delErr } = await supabase
          .from("device_credentials")
          .delete()
          .eq("user_id", item.requesterEmail)
          .eq("device_name", item.device_name)
          .eq("mqtt_user", item.mqtt_user ?? "")
          .eq("share_from", email);
        if (delErr) throw delErr;

        // 1b. 清空 owner row 的 notify，count + 1
        const { error: updErr } = await supabase
          .from("device_credentials")
          .update({ notify: null, count: item.share_count + 1 })
          .eq("id", item.id);
        if (updErr) throw updErr;

      } else {
        // source="share"：直接刪除該 share row，count 歸還由 RPC 補齊
        const { error: delErr } = await supabase
          .from("device_credentials")
          .delete()
          .eq("id", item.id);
        if (delErr) throw delErr;

        // 歸還主帳號 count（用 RPC 繞過 RLS）
        await supabase.rpc("return_share_count", {
          p_owner_email: email,
          p_device_name: item.device_name,
          p_mqtt_user:   item.mqtt_user ?? "",
        });
      }

      const remaining = notifyList.filter((d) => d.id !== item.id);
      setNotifyList(remaining);
      if (remaining.length === 0) setShowNotifyModal(false);
      await fetchDevices();
    } catch (err: any) {
      alert("確認失敗：" + (err.message || err));
    } finally {
      setNotifyProcessing(false);
    }
  };
  /* 只更新 device_name_custom，device_name 完全不動。
     還原條件（寫入 null）：
       ① 輸入框清空（空字串）
       ② 輸入值等於 device_name_initial 或 device_name（原始名稱）
     同步更新 share_from = email 的分享 row（相同 mqtt_user/pass/device_name）*/
  const handleRenameDevice = async () => {
    if (!selectedDevice) return;
    const trimmed = newDeviceName.trim();

    // 原始名稱（供裝初始值 → device_name 回退）
    const originalName = (selectedDevice.device_name_initial?.trim() || selectedDevice.device_name?.trim() || "");

    // 還原條件：清空 或 輸入原始名稱
    const isRestoring = trimmed === "" || trimmed === originalName;

    // 若自訂名稱已相同（且非還原），直接關閉
    if (!isRestoring && trimmed === (selectedDevice.device_name_custom?.trim() ?? "")) {
      setEditingName(false);
      return;
    }

    // 還原時寫 null，否則寫新名稱
    const newCustomValue: string | null = isRestoring ? null : trimmed;

    try {
      // 更新自己的 row（只寫 device_name_custom）
      const { error: e1 } = await supabase
        .from("device_credentials")
        .update({ device_name_custom: newCustomValue })
        .eq("id", selectedDevice.id);
      if (e1) throw e1;

      // 若是主帳號設備，同步更新所有分享 row 的 device_name_custom
      if (!selectedDevice.share_from) {
        await supabase
          .from("device_credentials")
          .update({ device_name_custom: newCustomValue })
          .eq("share_from", email)
          .eq("device_name", selectedDevice.device_name)
          .eq("mqtt_user", selectedDevice.mqtt_user ?? "");
      }

      // 更新本地 state（owner row + 同名分享 row 一併更新）
      const upd = devices.map((d) =>
        d.id === selectedDevice.id ||
        (!selectedDevice.share_from &&
          d.share_from === email &&
          d.device_name === selectedDevice.device_name &&
          d.mqtt_user  === selectedDevice.mqtt_user)
          ? { ...d, device_name_custom: newCustomValue }
          : d
      );
      setDevices(upd);
      setSelectedDevice({ ...selectedDevice, device_name_custom: newCustomValue });
      setEditingName(false);
    } catch (err: any) {
      alert("改名失敗：" + (err.message || err));
    }
  };

  /* ── 管理分享：載入被分享者清單 ──────────────────────────────────────
     需要 Supabase RLS：
     CREATE POLICY "owner can see shared rows"
     ON public.device_credentials FOR SELECT TO authenticated
     USING (share_from = auth.email());                                  */
  const openManageModal = async () => {
    if (!selectedDevice) return;
    setManageLoading(true);
    setSharedWithList([]);
    setShowManageModal(true);
    try {
      const { data } = await supabase
        .from("device_credentials")
        .select("id, user_id")
        .eq("share_from", email)
        .eq("device_name", selectedDevice.device_name)
        .eq("mqtt_user", selectedDevice.mqtt_user ?? "");
      setSharedWithList((data || []).map((r: any) => ({ id: r.id, user_id: r.user_id })));
    } catch (err) { console.error(err); }
    finally { setManageLoading(false); }
  };

  /* ── 主人撤銷某人的分享 ──────────────────────────────────────────────
     需要 Supabase RLS：
     CREATE POLICY "owner can delete shared rows"
     ON public.device_credentials FOR DELETE TO authenticated
     USING (share_from = auth.email());                                  */
  const handleRevokeShare = async (item: SharedWithItem) => {
    if (!selectedDevice) return;
    if (!confirm(`撤銷對 ${item.user_id} 的分享？`)) return;
    try {
      // DELETE 被分享者的 row
      const { error: delErr } = await supabase
        .from("device_credentials")
        .delete()
        .eq("id", item.id);
      if (delErr) throw delErr;

      // UPDATE owner count + 1（恢復一次分享次數）
      const { data: ownerRow } = await supabase
        .from("device_credentials")
        .select("id, count")
        .eq("user_id", email)
        .eq("device_name", selectedDevice.device_name)
        .eq("mqtt_user", selectedDevice.mqtt_user ?? "")
        .is("share_from", null)
        .single();
      if (ownerRow) {
        await supabase
          .from("device_credentials")
          .update({ count: parseInt(String(ownerRow.count ?? 0), 10) + 1 })
          .eq("id", ownerRow.id);
      }

      setSharedWithList((prev) => prev.filter((i) => i.id !== item.id));
      await fetchDevices();
    } catch (err: any) {
      alert("撤銷失敗：" + (err.message || err));
    }
  };

  /* ── 被分享者：自行離開分享 ────────────────────────────────────────────
     雙路寫入 notify，不直接刪除：
     路一：RPC 寫主帳號 owner row（繞過 RLS）
     路二：直接更新自己的 share row（保底）                              */
  const handleLeaveShare = async () => {
    if (!selectedDevice?.share_from) return;
    setLeaveLoading(true);
    const notifyVal = `${email} "要求刪除設備"`;
    try {
      const { error: directErr } = await supabase
        .from("device_credentials")
        .update({ notify: notifyVal })
        .eq("user_id", selectedDevice.share_from)
        .eq("device_name", selectedDevice.device_name)
        .eq("mqtt_user", selectedDevice.mqtt_user ?? "")
        .eq("mqtt_pass", selectedDevice.mqtt_pass ?? "")
        .is("share_from", null);
      if (directErr) {
        const { error: rpcErr } = await supabase.rpc("request_delete_share", {
          p_owner_email: selectedDevice.share_from,
          p_requester_id: email,
          p_device_name: selectedDevice.device_name,
          p_mqtt_user: selectedDevice.mqtt_user ?? "",
        });
        if (rpcErr) console.warn("[notify owner]", rpcErr.message);
      }

      // 路二
      const { error: selfErr } = await supabase
        .from("device_credentials")
        .update({ notify: notifyVal })
        .eq("id", selectedDevice.id);
      if (selfErr) console.warn("[notify 路二 self]", selfErr.message);

      setShowLeaveConfirm(false);
      alert("已通知主帳號刪除，待主帳號確認後將移除分享。");
    } catch (err: any) {
      alert("通知失敗：" + (err.message || err));
    } finally {
      setLeaveLoading(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="w-7 h-7 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  // 選定設備的伺服器狀態
  const selServerNo = selectedDevice
    ? (selectedDevice.server_no != null && selectedDevice.server_no > 0 ? selectedDevice.server_no : 1)
    : null;
  const selServerStatus = selServerNo != null ? (serverStatusMap[selServerNo] ?? "Connecting") : "Offline";
  // 選定設備的在線狀態（null = 尚未收到 retain 訊息）
  const selDeviceOnline = selectedDevice ? (deviceOnlineMap[selectedDevice.id] ?? null) : null;

  // 顏色輔助
  const serverColor = selServerStatus === "Online"
    ? "bg-green-500"
    : selServerStatus === "Connecting" ? "bg-yellow-400 animate-pulse" : "bg-red-500";
  const deviceColor = selDeviceOnline === true
    ? "bg-green-500"
    : selDeviceOnline === false ? "bg-red-500" : "bg-slate-500 animate-pulse";
  const serverLabel = selServerStatus === "Online" ? "線上" : selServerStatus === "Connecting" ? "連線中" : "離線";
  const deviceLabel = selDeviceOnline === true ? "在線" : selDeviceOnline === false ? "離線" : "偵測中";

  /* ══════════════════════════════ RENDER ══ */
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans select-none">

      {/* ══ 頂部帳號欄（桌面 + 手機共用）══ */}
      <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-tight">Smart Lock</h1>
          <div className="hidden md:flex items-center gap-2">
            <span className="text-slate-600 text-xs">伺服器</span>
            <div className={`w-1.5 h-1.5 rounded-full ${serverColor}`} />
            <span className="text-slate-500 text-xs">{serverLabel}</span>
            <span className="text-slate-700 text-xs">｜</span>
            <span className="text-slate-600 text-xs">設備</span>
            <div className={`w-1.5 h-1.5 rounded-full ${deviceColor}`} />
            <span className="text-slate-500 text-xs">{deviceLabel}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* 登入帳號顯示 */}
          <span className="text-xs text-slate-400 truncate max-w-[160px] md:max-w-xs" title={email}>
            {email}
          </span>
          {shareRemaining !== null ? (
            <span className={`hidden sm:inline text-xs px-2 py-0.5 rounded-full border ${
              shareRemaining > 0 ? "border-slate-600 text-slate-400" : "border-red-500/60 text-red-400"
            }`}>分享剩餘 {shareRemaining}</span>
          ) : selectedDevice ? (
            <span className="hidden sm:inline text-xs text-yellow-600 bg-yellow-500/10 border border-yellow-600/30 px-2 py-0.5 rounded-full">共享</span>
          ) : null}
          <button onClick={handleLogout} className="text-slate-500 hover:text-white p-1" title="登出">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ══ 主體：手機單欄 / 桌面雙欄 ══ */}
      <div className="md:flex md:h-[calc(100vh-41px)] md:overflow-hidden">

        {/* ── 左欄（手機全寬 / 桌面固定 360px）── */}
        <div className="md:w-[360px] md:flex-shrink-0 md:overflow-y-auto md:border-r md:border-slate-800 px-3 pt-3 pb-2">

          {/* 手機版連線狀態 + 設備名稱同排 */}
          <div className="flex items-center justify-between gap-2 mb-2 md:hidden">
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-slate-600 text-xs">伺服器</span>
              <div className={`w-1.5 h-1.5 rounded-full ${serverColor}`} />
              <span className="text-slate-500 text-xs">{serverLabel}</span>
              <span className="text-slate-700 text-xs mx-0.5">｜</span>
              <span className="text-slate-600 text-xs">設備</span>
              <div className={`w-1.5 h-1.5 rounded-full ${deviceColor}`} />
              <span className="text-slate-500 text-xs">{deviceLabel}</span>
            </div>
            {selectedDevice && (
              <span className="text-sm font-semibold text-slate-200 truncate text-right">
                {displayName(selectedDevice)}
              </span>
            )}
          </div>

          {/* 桌面版分享剩餘（因頂部欄空間有限，在左欄補充顯示）*/}
          {shareRemaining !== null && (
            <div className="hidden md:flex items-center justify-between mb-2 px-1">
              <span className="text-xs text-slate-500">設備控制</span>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${
                shareRemaining > 0 ? "border-slate-600 text-slate-400" : "border-red-500/60 text-red-400"
              }`}>分享剩餘 {shareRemaining}/{MAX_SHARES}</span>
            </div>
          )}

          {/* 設備選擇列 */}
          <div className="flex items-center gap-1.5 mb-2">
            {/* 改名模式 */}
            {editingName && selectedDevice ? (
              <div className="flex flex-1 gap-1">
                <input
                  autoFocus
                  value={newDeviceName}
                  onChange={(e) => setNewDeviceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameDevice();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  className="flex-1 bg-slate-800 border border-blue-500 text-white text-sm rounded-lg px-3 py-2 focus:outline-none"
                  placeholder={`原始：${selectedDevice.device_name_initial?.trim() || selectedDevice.device_name?.trim() || ""}（清空可還原）`}
                />
                <button onClick={handleRenameDevice}
                  className="px-3 py-2 bg-blue-600 text-white text-xs rounded-lg active:bg-blue-700 font-medium">
                  確認
                </button>
                <button onClick={() => setEditingName(false)}
                  className="px-2 py-2 bg-slate-700 text-slate-300 text-xs rounded-lg active:bg-slate-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              /* 正常模式：下拉（全寬）+ 連線狀態 + 齒輪設定 */
              <>
                <div className="relative flex-1 min-w-0">
                  <select
                    value={selectedDevice?.id ?? ""}
                    onChange={(e) => setActiveDevice(devices.find((d) => d.id === e.target.value) ?? null)}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-sm rounded-lg px-3 py-2 appearance-none focus:outline-none focus:border-blue-500 pr-6"
                  >
                    {devices.length === 0 && <option value="">無設備</option>}
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.share_from ? `⬦ ${displayName(d)}` : `● ${displayName(d)}`}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">▾</div>
                </div>
                <button onClick={() => setShowSettingsPanel(true)}
                  className="p-2 rounded-lg bg-blue-500 text-white active:bg-blue-600 flex-shrink-0"
                  title="設定">
                  <Settings className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>

          {/* 手動控制 */}
          <div className="mb-2">
            <p className="text-xs text-slate-500 mb-1.5 px-0.5">
              手動控制
              <span className="text-slate-700 ml-1">（長按可設定）</span>
            </p>
            <div className="grid grid-cols-3 gap-2">
              {([
                { action:"open", defaultLabel:"開",
                  accent:"#3b82f6", baseColor:"border-blue-500 text-blue-400",
                  pressedColor:"bg-blue-500/90 text-white border-blue-400",
                  glowColor:"shadow-blue-500/50" },
                { action:"stop", defaultLabel:"停",
                  accent:"#ef4444", baseColor:"border-red-500 text-red-400",
                  pressedColor:"bg-red-500/90 text-white border-red-400",
                  glowColor:"shadow-red-500/50" },
                { action:"down", defaultLabel:"關",
                  accent:"#94a3b8", baseColor:"border-slate-600 text-slate-300",
                  pressedColor:"bg-slate-500/90 text-white border-slate-400",
                  glowColor:"shadow-slate-500/40" },
              ] as const).map(({ action, defaultLabel, accent, baseColor, pressedColor, glowColor }) => {
                const isPressed   = triggeredAction === action;
                const label       = btnLabels[action] || defaultLabel;
                const cfg         = timerConfigs[action];
                const hasPeriodic = cfg?.active && cfg.mode === "periodic";
                const hasSchedule = cfg?.active && cfg.mode === "schedule";
                // 分享設備：排程設定來自 ESP32（唯讀顯示，用琥珀色區分）
                const isSharedSched = !!(selectedDevice?.share_from && (hasPeriodic || hasSchedule));

                const fontSize = label.length <= 2 ? "1.1rem"
                               : label.length <= 4 ? "0.88rem"
                               : label.length <= 6 ? "0.74rem" : "0.64rem";

                const periodicSubLabel = hasPeriodic && cfg?.intervalSec
                  ? formatIntervalLabel(cfg.intervalSec)
                  : null;

                // 排程副文字：顯示 HH:MM
                const schedSubLabel = hasSchedule && cfg?.schedule
                  ? `${String(cfg.schedule.hour).padStart(2,"0")}:${String(cfg.schedule.minute).padStart(2,"0")}`
                  : null;

                return (
                  <div key={action} className="relative">
                    <button
                      onPointerDown={() => {
                        longPressTimer.current = setTimeout(() => handleBtnLongPress(action), 600);
                      }}
                      onPointerUp={() => {
                        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
                      }}
                      onPointerLeave={() => {
                        if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
                      }}
                      onClick={() => handleBtnClick(action)}
                      style={{
                        fontSize,
                        transition: "transform 0.1s, background-color 0.12s",
                        ...(hasPeriodic && !isPressed ? {
                          animation: "timerPulse 2.5s ease-in-out infinite",
                          boxShadow: isSharedSched
                            ? `0 0 12px 3px #f59e0b55, inset 0 0 16px #f59e0b18`
                            : `0 0 12px 3px ${accent}55, inset 0 0 16px ${accent}18`,
                        } : {}),
                        ...(hasSchedule && !isPressed ? {
                          animation: "schedPulse 4s ease-in-out infinite",
                          boxShadow: isSharedSched
                            ? `0 0 10px 2px #f59e0b44, inset 0 0 14px #f59e0b14`
                            : `0 0 10px 2px #818cf844, inset 0 0 14px #818cf814`,
                        } : {}),
                      }}
                      className={`
                        w-full py-3 md:py-4 rounded-xl border-2 font-bold
                        flex flex-col items-center justify-center text-center
                        leading-tight px-1 break-words min-h-[68px] select-none
                        relative overflow-hidden
                        ${isPressed
                          ? `${pressedColor} scale-95 shadow-lg ${glowColor}`
                          : `${baseColor} bg-slate-900 active:scale-95`}
                      `}
                    >
                      {/* 主文字 */}
                      <span>{isPressed ? "✓" : label}</span>
                      {/* 副文字：分享設備顯示「主機」前綴，提示為 owner 在 ESP32 上設定的排程 */}
                      {!isPressed && (hasPeriodic || hasSchedule) && (
                        <span className={`text-[9px] font-mono leading-none mt-0.5 ${
                          isSharedSched ? "text-amber-400 opacity-80" : "opacity-60"
                        }`}>
                          {isSharedSched
                            ? `主機 ${hasPeriodic ? (periodicSubLabel ?? "") : (schedSubLabel ?? "")}`
                            : hasPeriodic ? (periodicSubLabel ?? "") : (schedSubLabel ?? "")}
                        </span>
                      )}
                    </button>
                    {/* 角標：分享設備用琥珀色圖示，與 owner 的藍/紫色區分 */}
                    {(hasPeriodic || hasSchedule) && (
                      <span className={`absolute top-1 right-1 pointer-events-none ${
                        isSharedSched ? "opacity-90" : "opacity-60"
                      }`}>
                        {hasPeriodic
                          ? <Clock  style={{ width:10, height:10, color: isSharedSched ? "#f59e0b" : accent }} />
                          : <Timer  style={{ width:10, height:10, color: isSharedSched ? "#f59e0b" : "#818cf8" }} />}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 設備帳密快速資訊（桌面版直接顯示在左欄）*/}
          {selectedDevice && (
            <div className="hidden md:block bg-slate-800/50 rounded-xl border border-slate-700 px-3 py-2.5 mb-2">
              <p className="text-xs text-slate-500 mb-1.5">設備資訊</p>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">顯示名稱</span>
                  <span className="text-slate-200 font-medium truncate max-w-[160px]">{displayName(selectedDevice)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">帳號</span>
                  <span className="text-slate-300 font-mono">{selectedDevice.mqtt_user || "未設定"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">密碼</span>
                  <span className="text-slate-300 font-mono">{selectedDevice.mqtt_pass || "未設定"}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">伺服器</span>
                  <span className="flex items-center gap-1">
                    <div className={`w-1.5 h-1.5 rounded-full ${serverColor}`} />
                    <span className="text-slate-300">{serverLabel}</span>
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">設備</span>
                  <span className="flex items-center gap-1">
                    <div className={`w-1.5 h-1.5 rounded-full ${deviceColor}`} />
                    <span className="text-slate-300">{deviceLabel}</span>
                  </span>
                </div>
                {selectedDevice.share_from && (
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-500">分享者</span>
                    <span className="text-yellow-500 truncate max-w-[160px]">{selectedDevice.share_from}</span>
                  </div>
                )}
              </div>
            </div>
          )}



        </div>

        {/* ── 右欄（手機全寬 / 桌面佔剩餘空間）── */}
        <div className="md:flex-1 md:overflow-y-auto px-3 md:px-4 pt-0 md:pt-3 pb-4">

          {/* 地圖 */}
          <div className="bg-slate-900 rounded-xl border border-slate-800 mb-2">
            {/* 工具列 */}
            <div className="px-2.5 py-1.5 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">地點地圖</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setIsStreetView((v) => !v)}
                  className={`px-2 py-0.5 rounded-full border text-xs font-medium ${
                    isStreetView ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-800 border-slate-700 text-slate-300"
                  }`}>
                  {isStreetView ? "街道" : "衛星"}
                </button>
                <button onClick={() => nav(-1)} disabled={!savedLocations.length}
                  className="bg-slate-800 rounded-full border border-slate-700 w-6 h-6 flex items-center justify-center disabled:opacity-30">
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => nav(1)} disabled={!savedLocations.length}
                  className="bg-slate-800 rounded-full border border-slate-700 w-6 h-6 flex items-center justify-center disabled:opacity-30">
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <button onClick={handleLocate} disabled={gpsLoading}
                  className={`rounded-full border w-6 h-6 flex items-center justify-center ${
                    gpsLoading   ? "bg-yellow-500/20 border-yellow-500 text-yellow-400" :
                    userPosition ? "bg-green-500/20  border-green-500  text-green-400"  :
                                   "bg-slate-800 border-slate-700"
                  }`}>
                  {gpsLoading
                    ? <div className="w-3 h-3 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
                    : <Crosshair className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* 狀態 + 取消 */}
            <div className="px-2.5 pb-1 flex items-center justify-between gap-2 min-h-[20px]">
              <p className="text-xs text-slate-400 truncate">
                {gpsError && !userPosition
                  ? <span className="text-red-400">{gpsError}</span>
                  : pendingLocation
                  ? `📍 ${pendingLocation[0].toFixed(4)}, ${pendingLocation[1].toFixed(4)}`
                  : gpsLoading
                  ? "正在自動定位..."
                  : userPosition
                  ? `✅ ${userPosition[0].toFixed(4)}, ${userPosition[1].toFixed(4)}`
                  : "點地圖選位置，或按 ⊕ GPS"}
              </p>
              {pendingLocation && (
                <button onClick={() => setPendingLocation(null)}
                  className="flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 text-xs flex-shrink-0">
                  <X className="w-3 h-3" />取消
                </button>
              )}
            </div>

            {/* 地圖本體：手機 h-72 / 桌面佔更多高度 */}
            <div className="h-72 md:h-[520px] w-full overflow-hidden rounded-b-xl">
              <MapContainer
                center={userPosition || DEFAULT_CENTER}
                zoom={18} minZoom={3} maxZoom={22}
                zoomControl={false}
                style={{ height: "100%", width: "100%" }}
              >
                {isStreetView ? (
                  <TileLayer key="street"
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution="&copy; <a href='https://www.openstreetmap.org/copyright'>OSM</a> contributors"
                    maxZoom={22} maxNativeZoom={19} keepBuffer={8}
                    tileSize={256} zoomOffset={0}
                    detectRetina={true} />
                ) : (
                  <TileLayer key="satellite"
                    url="https://mt{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
                    subdomains={["0","1","2","3"] as any}
                    attribution="&copy; Google Maps"
                    maxZoom={22} maxNativeZoom={21} keepBuffer={8}
                    tileSize={256} zoomOffset={0}
                    detectRetina={true} />
                )}
                <FlyTo target={flyTarget} />
                <MapClickHandler onMapClick={setPendingLocation} />
                {userPosition && (
                  <>
                    <Circle center={userPosition} radius={12}
                      pathOptions={{ fillColor:"#3b82f6", fillOpacity:0.15, color:"#3b82f6", weight:1.5 }} />
                    <Marker position={userPosition} icon={gpsIcon} />
                  </>
                )}
                {pendingLocation && <Marker position={pendingLocation} icon={pendingIcon} />}
                {savedLocations.map((loc) => (
                  <Marker key={loc.id} position={loc.position} icon={savedIcon} />
                ))}
              </MapContainer>
            </div>

            <div className="px-2.5 py-1.5 border-t border-slate-800">
              <p className="text-xs text-slate-400">
                {savedLocations.length > 0
                  ? `${savedLocations[activeLocIdx]?.label}（${activeLocIdx + 1}/${savedLocations.length}）`
                  : "尚未儲存地點"}
              </p>
            </div>
          </div>

          {/* 位置設定 */}
          <div className="bg-slate-900 rounded-xl px-3 py-2 border border-slate-800 mb-2">
            <h2 className="text-xs font-bold text-slate-400 mb-1.5">位置設定</h2>
            <button onClick={openNameModal} disabled={!pendingLocation}
              className="w-full py-2.5 rounded-xl border border-purple-600 bg-purple-900/20 text-white font-bold text-sm active:bg-purple-900/40 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <MapPin className="w-4 h-4" />
              {pendingLocation ? "新增地點（輸入名稱）" : "新增地點（請先點選地圖）"}
            </button>
            {savedLocations.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {savedLocations.map((loc, idx) => (
                  <div key={loc.id}
                    className={`flex items-center justify-between px-2 py-1.5 rounded-lg border text-xs ${
                      idx === activeLocIdx ? "border-purple-500 bg-purple-500/10" : "border-slate-700 bg-slate-800"
                    }`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${idx === activeLocIdx ? "bg-purple-400" : "bg-slate-500"}`} />
                      <span className="text-slate-300 truncate">{loc.label}</span>
                      <span className="text-slate-500 flex-shrink-0">{loc.position[0].toFixed(3)},{loc.position[1].toFixed(3)}</span>
                    </div>
                    <div className="flex gap-3 ml-2 flex-shrink-0">
                      <button onClick={() => { setActiveLocIdx(idx); setFlyTarget(loc.position); }} className="text-blue-400">前往</button>
                      <button onClick={async () => {
                        // 先從本地移除（UI 即時）
                        const upd = savedLocations.filter((_, i) => i !== idx);
                        setSavedLocations(upd);
                        setActiveLocIdx(Math.min(activeLocIdx, Math.max(0, upd.length - 1)));
                        // 同步刪除 DB（loc.id 是 DB UUID）
                        try {
                          const { error } = await supabase
                            .from("locations")
                            .delete()
                            .eq("id", loc.id);
                          if (error) console.warn("[locations] 刪除失敗:", error.message);
                        } catch (err) {
                          console.warn("[locations] 刪除例外:", err);
                        }
                      }} className="text-red-400">刪除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>{/* end 右欄 */}
      </div>{/* end 雙欄 */}

      {/* ══ 分享設備 Modal ══ */}
      {showShareModal && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowShareModal(false)}>
            <div className="bg-slate-900 border-t border-blue-500/40 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <h3 className="text-sm font-bold mb-0.5">分享設備</h3>
              <p className="text-xs text-slate-500 mb-3">
                {displayName(selectedDevice)}・剩餘 {shareRemaining} 次
              </p>
              {shareError && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">
                  {shareError}
                </p>
              )}
              <label className="block text-xs text-slate-400 mb-1">對方的 Email（需已註冊）</label>
              <input
                type="email"
                value={shareEmail}
                onChange={(e) => setShareEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleShare()}
                placeholder="example@email.com"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 mb-3"
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={() => setShowShareModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                  取消
                </button>
                <button onClick={handleShare} disabled={shareLoading}
                  className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-bold active:bg-blue-700 flex items-center justify-center gap-2">
                  {shareLoading
                    ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <><Share2 className="w-4 h-4" />確認分享</>}
                </button>
              </div>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 地點命名 Modal ══ */}
      {showNameModal && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowNameModal(false)}>
            <div className="bg-slate-900 border-t border-purple-500/40 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <h3 className="text-sm font-bold mb-1">為地點命名</h3>
              <p className="text-xs text-slate-500 mb-3">
                📍 {pendingLocation?.[0].toFixed(5)}, {pendingLocation?.[1].toFixed(5)}
              </p>
              <input
                type="text"
                value={pendingName}
                onChange={(e) => setPendingName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmAddLocation()}
                placeholder="輸入地點名稱"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-purple-500 mb-3"
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={() => { setShowNameModal(false); setPendingName(""); }}
                  className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                  取消
                </button>
                <button onClick={confirmAddLocation}
                  className="flex-1 py-2.5 rounded-xl bg-purple-600 text-white text-sm font-bold active:bg-purple-700">
                  ✚ 新增
                </button>
              </div>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 設備帳密 Sheet ══ */}
      {showCredentials && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowCredentials(false)}>
            <div className="bg-slate-900 border-t border-slate-700 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <h3 className="text-sm font-bold mb-3">設備帳密</h3>
              {selectedDevice ? (
                <div className="space-y-2.5">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">帳號</label>
                    <div className="bg-slate-800 p-2.5 rounded-lg font-mono text-sm border border-slate-700 break-all">
                      {selectedDevice.mqtt_user || "未設定"}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">密碼</label>
                    <div className="bg-slate-800 p-2.5 rounded-lg font-mono text-sm border border-slate-700 break-all">
                      {selectedDevice.mqtt_pass || "未設定"}
                    </div>
                  </div>
                </div>
              ) : <p className="text-slate-400 text-sm">請先選擇設備</p>}
              <button onClick={() => setShowCredentials(false)}
                className="w-full bg-blue-600 text-white font-bold py-2.5 rounded-xl mt-4 text-sm active:bg-blue-700">
                關閉
              </button>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 管理分享 Modal（主人查看被分享者，可撤銷）══ */}
      {showManageModal && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowManageModal(false)}>
            <div className="bg-slate-900 border-t border-purple-500/40 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold">管理分享</h3>
                <span className="text-xs text-slate-500">{displayName(selectedDevice)}</span>
              </div>

              {manageLoading ? (
                <div className="flex justify-center py-6">
                  <div className="w-6 h-6 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : sharedWithList.length === 0 ? (
                <div className="text-center py-6">
                  <Users className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-slate-500 text-sm">尚未分享給任何人</p>
                </div>
              ) : (
                <div className="space-y-2 mb-3 max-h-60 overflow-y-auto">
                  {sharedWithList.map((item) => (
                    <div key={item.id}
                      className="flex items-center justify-between px-3 py-2.5 bg-slate-800 rounded-xl border border-slate-700">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full bg-yellow-500 flex-shrink-0" />
                        <span className="text-sm text-slate-200 truncate">{item.user_id}</span>
                      </div>
                      <button
                        onClick={() => handleRevokeShare(item)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-medium active:bg-red-500/40 flex-shrink-0 ml-2">
                        <UserMinus className="w-3 h-3" />撤銷
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button onClick={() => setShowManageModal(false)}
                className="w-full py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                關閉
              </button>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 離開分享確認 Modal（被分享者）══ */}
      {showLeaveConfirm && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowLeaveConfirm(false)}>
            <div className="bg-slate-900 border-t border-orange-500/40 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <h3 className="text-sm font-bold mb-1 text-orange-400">離開分享</h3>
              <p className="text-slate-300 text-xs mb-0.5">
                確定要通知主帳號移除「{displayName(selectedDevice)}」的分享？
              </p>
              <p className="text-slate-500 text-xs mb-4">
                通知送出後，待主帳號確認後才會正式移除，在此之前仍可繼續使用設備。
              </p>
              <div className="flex gap-2">
                <button onClick={() => setShowLeaveConfirm(false)} disabled={leaveLoading}
                  className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                  取消
                </button>
                <button onClick={handleLeaveShare} disabled={leaveLoading}
                  className="flex-1 py-2.5 rounded-xl bg-orange-600 text-white text-sm font-bold active:bg-orange-700 flex items-center justify-center gap-2">
                  {leaveLoading
                    ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <><UserMinus className="w-4 h-4" />通知主帳號</>}
                </button>
              </div>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 重置確認 Sheet ══ */}
      {showResetConfirm && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowResetConfirm(false)}>
            <div className="bg-slate-900 border-t border-red-500/40 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <h3 className="text-sm font-bold mb-1 text-red-400">確認重置</h3>
              <p className="text-slate-300 text-xs mb-0.5">此操作將清除帳號下所有設備資料。</p>
              <p className="text-slate-500 text-xs mb-4">⚠ 登入資格不受影響，重置後仍可登入。</p>
              <div className="flex gap-2">
                <button onClick={() => setShowResetConfirm(false)} disabled={resetting}
                  className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                  取消
                </button>
                <button onClick={handleReset} disabled={resetting}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 text-white text-sm font-bold active:bg-red-700 flex items-center justify-center gap-2">
                  {resetting
                    ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : "確認重置"}
                </button>
              </div>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 長按改名 Modal ══ */}
      {editingBtn && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setEditingBtn(null)}>
            <div className="bg-slate-900 border-t border-blue-500/40 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <h3 className="text-sm font-bold mb-1">更改按鈕名稱</h3>
              <p className="text-xs text-slate-500 mb-3">清空可還原預設名稱</p>
              <input
                type="text"
                value={editBtnName}
                onChange={(e) => setEditBtnName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && confirmBtnRename()}
                maxLength={12}
                placeholder="輸入按鈕名稱"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-blue-500 mb-3"
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={() => setEditingBtn(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                  取消
                </button>
                <button onClick={confirmBtnRename}
                  className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-bold active:bg-blue-700">
                  確認
                </button>
              </div>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 刪除通知 Modal（主帳號收到被分享者要求刪除）══ */}
      {showNotifyModal && notifyList.length > 0 && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center px-4" style={{ zIndex: 99999 }}>
            <div className="bg-slate-900 border border-orange-500/60 rounded-2xl p-5 w-full max-w-lg shadow-2xl">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-2xl">🔔</span>
                <div>
                  <h3 className="text-base font-bold text-orange-400">收到刪除分享通知</h3>
                  <p className="text-xs text-slate-400">以下被分享者要求移除其分享</p>
                </div>
              </div>

              <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
                {notifyList.map((item) => {
                  const devLabel = item.device_name_custom?.trim()
                    || item.device_name_initial?.trim()
                    || item.device_name;
                  return (
                    <div key={`${item.id}-${item.source}`}
                      className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3">
                      <div className="min-w-0 mb-2">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-white truncate">{devLabel}</p>
                          {item.source === "share" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 flex-shrink-0">保底</span>
                          )}
                        </div>
                        <p className="text-xs text-orange-300 mt-0.5 truncate">
                          {item.requesterEmail} 要求刪除分享
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            const remaining = notifyList.filter(
                              (d) => !(d.id === item.id && d.source === item.source)
                            );
                            setNotifyList(remaining);
                            if (remaining.length === 0) setShowNotifyModal(false);
                          }}
                          disabled={notifyProcessing}
                          className="flex-1 py-2 rounded-lg border border-slate-600 text-slate-300 text-xs font-medium active:bg-slate-700">
                          稍後處理
                        </button>
                        <button
                          onClick={() => handleConfirmNotify(item)}
                          disabled={notifyProcessing}
                          className="flex-1 py-2 rounded-lg bg-orange-500 text-white text-xs font-bold active:bg-orange-600 flex items-center justify-center gap-1">
                          {notifyProcessing
                            ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            : <><UserMinus className="w-3.5 h-3.5" />確認移除</>}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                onClick={() => setShowNotifyModal(false)}
                className="w-full py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                關閉（可在管理分享內處理）
              </button>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 設定面板 Sheet ══ */}
      {showSettingsPanel && (
        <PortalModal>
          <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
            onClick={() => setShowSettingsPanel(false)}>
            <div className="bg-slate-900 border-t border-slate-700 rounded-t-2xl p-5 w-full max-w-lg"
              onClick={(e) => e.stopPropagation()}>
              <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
              <div className="flex items-center gap-2 mb-4">
                <Settings className="w-4 h-4 text-blue-400" />
                <h3 className="text-sm font-bold">設定</h3>
                {selectedDevice && (
                  <span className="text-xs text-slate-400 truncate ml-auto max-w-[160px]">
                    {displayName(selectedDevice)}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {/* 設備帳密 */}
                {selectedDevice && (
                  <div className="bg-slate-800 rounded-xl border border-slate-700 px-4 py-3">
                    <p className="text-xs text-slate-400 mb-2">設備帳密</p>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500">帳號</span>
                        <span className="text-slate-200 font-mono">{selectedDevice.mqtt_user || "未設定"}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-500">密碼</span>
                        <span className="text-slate-200 font-mono">{selectedDevice.mqtt_pass || "未設定"}</span>
                      </div>
                      {selectedDevice.share_from && (
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">分享者</span>
                          <span className="text-yellow-400 truncate max-w-[160px]">{selectedDevice.share_from}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 主帳號功能 */}
                {isOwnDevice && (
                  <>
                    {/* 改名 */}
                    <button
                      onClick={() => { setShowSettingsPanel(false); setNewDeviceName(displayName(selectedDevice)); setEditingName(true); }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl active:bg-slate-700 text-left">
                      <Pencil className="w-4 h-4 text-slate-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm text-slate-200">修改設備名稱</p>
                        <p className="text-xs text-slate-500">自訂顯示名稱</p>
                      </div>
                    </button>

                    {/* 分享 */}
                    <button
                      onClick={() => { setShowSettingsPanel(false); setShareEmail(""); setShareError(""); setShowShareModal(true); }}
                      disabled={(shareRemaining ?? 0) <= 0}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl active:bg-slate-700 text-left disabled:opacity-40">
                      <Share2 className="w-4 h-4 text-blue-400 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm text-slate-200">分享設備</p>
                        <p className="text-xs text-slate-500">剩餘 {shareRemaining}/{MAX_SHARES} 次</p>
                      </div>
                    </button>

                    {/* 管理分享 */}
                    <button
                      onClick={() => { setShowSettingsPanel(false); openManageModal(); }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl active:bg-slate-700 text-left">
                      <Users className="w-4 h-4 text-purple-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm text-slate-200">管理分享</p>
                        <p className="text-xs text-slate-500">查看或撤銷已分享的帳號</p>
                      </div>
                    </button>

                    {/* 刪除設備 */}
                    <button
                      onClick={() => { setShowSettingsPanel(false); selectedDevice && handleDeleteDevice(selectedDevice); }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-red-500/30 rounded-xl active:bg-red-500/10 text-left">
                      <Trash2 className="w-4 h-4 text-red-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm text-red-400">刪除設備</p>
                        <p className="text-xs text-slate-500">從帳號移除此設備</p>
                      </div>
                    </button>
                  </>
                )}

                {/* 被分享者：離開分享 */}
                {selectedDevice?.share_from && (
                  <button
                    onClick={() => { setShowSettingsPanel(false); setShowLeaveConfirm(true); }}
                    className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-orange-500/30 rounded-xl active:bg-orange-500/10 text-left">
                    <UserMinus className="w-4 h-4 text-orange-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-orange-400">離開分享</p>
                      <p className="text-xs text-slate-500">通知主帳號移除分享</p>
                    </div>
                  </button>
                )}

                {/* 重置 */}
                <button
                  onClick={() => { setShowSettingsPanel(false); setShowResetConfirm(true); }}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-red-500/40 rounded-xl active:bg-red-500/10 text-left">
                  <LogOut className="w-4 h-4 text-red-500 flex-shrink-0" />
                  <div>
                    <p className="text-sm text-red-400 font-semibold">重置帳號</p>
                    <p className="text-xs text-slate-500">清除所有設備資料</p>
                  </div>
                </button>
              </div>

              <button onClick={() => setShowSettingsPanel(false)}
                className="w-full mt-4 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm font-medium active:bg-slate-800">
                關閉
              </button>
            </div>
          </div>
        </PortalModal>
      )}

      {/* ══ 按鈕長按選單 ══ */}
      {showBtnMenu && (() => {
        const action = showBtnMenu;
        const defaultLabels: Record<string,string> = { open:"開", stop:"停", down:"關" };
        const btnLabel = btnLabels[action] || defaultLabels[action] || action;
        const cfg = timerConfigs[action];
        const hasCfg = cfg?.active;
        const isSharedDevice = !!selectedDevice?.share_from;
        const fmtSec = (s: number) =>
          s >= 3600 ? `${Math.floor(s/3600)}h${Math.floor((s%3600)/60)}m`
                    : s >= 60   ? `${Math.floor(s/60)}m${s%60 > 0 ? `${s%60}s` : ""}` : `${s}s`;
        const cfgSummary = () => {
          if (!hasCfg || !cfg) return "未設定";
          if (cfg.mode === "periodic") return `定期觸發 · 每 ${fmtSec(cfg.intervalSec ?? 60)}`;
          const s = cfg.schedule;
          if (!s) return "排程觸發（未設定）";
          const t = `${String(s.hour).padStart(2,"0")}:${String(s.minute).padStart(2,"0")}`;
          if (s.type === "weekday") {
            const dayNames = ["一","二","三","四","五","六","日"];
            const days = dayNames.filter((_,i) => (s.weekMask ?? 31) & (1<<i)).join("、");
            return `排程 · 週${days} ${t}`;
          }
          const cnt = s.dates?.length ?? 0;
          return `排程 · ${cnt} 個日期 ${t}`;
        };
        return (
          <PortalModal>
            <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
              onClick={() => setShowBtnMenu(null)}>
              <div className="bg-slate-900 border-t border-slate-700 rounded-t-2xl p-5 w-full max-w-lg"
                onClick={e => e.stopPropagation()}>
                <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
                <p className="text-xs text-slate-400 text-center mb-4">「{btnLabel}」設定</p>
                <div className="space-y-2">
                  {/* 改名 */}
                  <button onClick={() => {
                    setShowBtnMenu(null);
                    const defaultLabels2: Record<string,string> = { open:"開", stop:"停", down:"關" };
                    setEditBtnName(btnLabels[action] || defaultLabels2[action] || "");
                    setEditingBtn(action);
                  }} className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-slate-700 rounded-xl active:bg-slate-700 text-left">
                    <Pencil className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm text-slate-200">修改按鈕名稱</p>
                      <p className="text-xs text-slate-500">目前：{btnLabel}</p>
                    </div>
                  </button>
                  {!isSharedDevice && (
                    <button
                      onClick={() => {
                        setEditTimerMode(cfg?.mode ?? "periodic");
                        setEditTimerSec(cfg?.intervalSec ?? 60);
                        if (cfg?.mode === "schedule" && cfg.schedule) {
                          setEditSchedType(cfg.schedule.type);
                          setEditSchedHour(cfg.schedule.hour);
                          setEditSchedMin(cfg.schedule.minute);
                          if (cfg.schedule.type === "weekday") {
                            const mask = cfg.schedule.weekMask ?? 31;
                            setEditSchedDays([1,2,3,4,5,6,7].filter(d => mask & (1<<(d-1))));
                            setEditSchedDates([]);
                          } else {
                            setEditSchedDays([]);
                            setEditSchedDates(cfg.schedule.dates ?? []);
                          }
                        } else {
                          setEditSchedType("weekday");
                          setEditSchedDays([1,2,3,4,5]);
                          setEditSchedDates([]);
                          setEditSchedHour(8);
                          setEditSchedMin(0);
                        }
                        setShowTimerModal(action);
                        setShowBtnMenu(null);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 border rounded-xl text-left bg-slate-800 border-slate-700 active:bg-slate-700"
                    >
                      <Clock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm text-slate-200">定時觸發設定</p>
                        <p className="text-xs text-slate-500">{cfgSummary()}</p>
                      </div>
                      {hasCfg && (
                        <span className="text-[10px] bg-yellow-400/20 border border-yellow-400/40 text-yellow-300 px-1.5 py-0.5 rounded-full">ON</span>
                      )}
                    </button>
                  )}
                  {/* 快速停用（已啟用時顯示）*/}
                  {hasCfg && !isSharedDevice && (
                    <button onClick={() => { saveTimerConfig(action, null); setShowBtnMenu(null); }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-slate-800 border border-red-500/30 rounded-xl active:bg-red-500/10 text-left">
                      <X className="w-4 h-4 text-red-400 flex-shrink-0" />
                      <p className="text-sm text-red-400">停用定時觸發</p>
                    </button>
                  )}
                </div>
                <button onClick={() => setShowBtnMenu(null)}
                  className="w-full mt-3 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm active:bg-slate-800">
                  取消
                </button>
              </div>
            </div>
          </PortalModal>
        );
      })()}

      {/* ══ 定時觸發設定 Modal ══ */}
      {showTimerModal && (() => {
        const action = showTimerModal;
        const defaultLabels: Record<string,string> = { open:"開", stop:"停", down:"關" };
        const btnLabel    = btnLabels[action] || defaultLabels[action] || action;
        const existingCfg = timerConfigs[action];
        const safeSec     = Math.max(60, editTimerSec);
        const fmtSec = (s: number) =>
          s >= 3600 ? `${Math.floor(s/3600)} 小時 ${Math.floor((s%3600)/60)} 分鐘`
                    : `${Math.floor(s/60)} 分鐘${s%60>0?` ${s%60} 秒`:""}`;
        const DAY_NAMES = ["一","二","三","四","五","六","日"];

        const toggleDay = (d: number) =>
          setEditSchedDays(prev => prev.includes(d) ? prev.filter(x=>x!==d) : [...prev,d].sort());

        const addDate = (v: string) => {
          if (!v || editSchedDates.includes(v)) return;
          setEditSchedDates(prev => [...prev, v].sort());
        };

        const buildCfg = (): TimerCfg => {
          if (editTimerMode === "periodic") {
            return {
              mode: "periodic",
              intervalSec: safeSec,
              periodicStartedAt: existingCfg?.mode === "periodic" && existingCfg.periodicStartedAt
                ? existingCfg.periodicStartedAt
                : Date.now(),
              active: true,
            };
          }
          const mask = editSchedDays.reduce((acc, d) => acc | (1<<(d-1)), 0);
          return {
            mode: "schedule",
            active: true,
            schedule: {
              type:     editSchedType,
              weekMask: editSchedType === "weekday" ? mask : 0,
              dates:    editSchedType === "date"    ? editSchedDates : [],
              hour:     editSchedHour,
              minute:   editSchedMin,
            },
          };
        };

        return (
          <PortalModal>
            <div className="fixed inset-0 bg-black/70 flex items-end justify-center" style={{ zIndex: 99999 }}
              onClick={() => setShowTimerModal(null)}>
              <div className="bg-slate-900 border-t border-yellow-500/40 rounded-t-2xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto"
                onClick={e => e.stopPropagation()}>
                <div className="w-10 h-1 bg-slate-700 rounded-full mx-auto mb-3" />
                <div className="flex items-center gap-2 mb-1">
                  <Clock className="w-4 h-4 text-yellow-400" />
                  <h3 className="text-sm font-bold">定時觸發設定</h3>
                  <span className="text-xs text-slate-400 ml-auto">「{btnLabel}」</span>
                </div>

                {/* ── 模式選擇 ── */}
                <p className="text-xs text-slate-400 mb-2">觸發模式</p>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {([
                    { m:"periodic" as const, icon:"🔁", t:"定期觸發" },
                    { m:"schedule" as const, icon:"📅", t:"排程觸發" },
                  ]).map(({ m, icon, t }) => (
                    <button key={m} onClick={() => setEditTimerMode(m)}
                      className={`flex flex-col items-start gap-0.5 px-3 py-2.5 rounded-xl border text-left ${
                        editTimerMode === m
                          ? "bg-yellow-500/15 border-yellow-500 text-yellow-200"
                          : "bg-slate-800 border-slate-700 text-slate-400 active:bg-slate-700"}`}>
                      <span className="text-base">{icon}</span>
                      <span className="text-xs font-semibold">{t}</span>
                    </button>
                  ))}
                </div>

                {/* ── periodic ── */}
                {editTimerMode === "periodic" && (
                  <>
                    <p className="text-xs text-slate-400 mb-1.5">觸發間隔（秒，最短 60）</p>
                    <input type="number" min={60} max={86400}
                      value={editTimerSec}
                      onChange={e => setEditTimerSec(Math.max(60, parseInt(e.target.value)||60))}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-yellow-500 mb-1.5"
                    />
                    <p className="text-xs text-yellow-400/80 mb-3">→ {fmtSec(safeSec)}</p>
                    <div className="flex gap-1.5 flex-wrap mb-2">
                      {[60,120,300,600,1800,3600].map(s => (
                        <button key={s} onClick={() => setEditTimerSec(s)}
                          className={`px-2.5 py-1 rounded-lg text-xs border ${
                            editTimerSec===s
                              ? "bg-yellow-500/20 border-yellow-500 text-yellow-300"
                              : "bg-slate-800 border-slate-700 text-slate-400 active:bg-slate-700"}`}>
                          {s>=3600?`${s/3600}h`:`${s/60}m`}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {/* ── schedule ── */}
                {editTimerMode === "schedule" && (
                  <>
                    {/* 日期類型 */}
                    <p className="text-xs text-slate-400 mb-2">觸發日</p>
                    <div className="grid grid-cols-2 gap-2 mb-4">
                      {([
                        { v:"weekday" as const, label:"工作日 / 每週重複" },
                        { v:"date"    as const, label:"指定特定日期" },
                      ]).map(({ v, label }) => (
                        <button key={v} onClick={() => setEditSchedType(v)}
                          className={`py-2 rounded-xl border text-xs font-medium ${
                            editSchedType===v
                              ? "bg-indigo-500/20 border-indigo-400 text-indigo-200"
                              : "bg-slate-800 border-slate-700 text-slate-400 active:bg-slate-700"}`}>
                          {label}
                        </button>
                      ))}
                    </div>

                    {/* weekday picker */}
                    {editSchedType === "weekday" && (
                      <div className="mb-4">
                        <div className="flex gap-1.5 justify-between mb-2">
                          {DAY_NAMES.map((name, i) => {
                            const d = i + 1;
                            const on = editSchedDays.includes(d);
                            return (
                              <button key={d} onClick={() => toggleDay(d)}
                                className={`flex-1 py-2 rounded-lg text-xs font-bold border ${
                                  on ? "bg-indigo-500 border-indigo-400 text-white"
                                     : "bg-slate-800 border-slate-700 text-slate-400 active:bg-slate-700"}`}>
                                {name}
                              </button>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <button onClick={() => setEditSchedDays([1,2,3,4,5])}
                            className="text-xs text-indigo-400 px-2 py-1 bg-indigo-500/10 border border-indigo-500/30 rounded-lg active:bg-indigo-500/20">
                            週一~五
                          </button>
                          <button onClick={() => setEditSchedDays([1,2,3,4,5,6,7])}
                            className="text-xs text-indigo-400 px-2 py-1 bg-indigo-500/10 border border-indigo-500/30 rounded-lg active:bg-indigo-500/20">
                            每天
                          </button>
                          <button onClick={() => setEditSchedDays([])}
                            className="text-xs text-slate-400 px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg active:bg-slate-700">
                            清空
                          </button>
                        </div>
                      </div>
                    )}

                    {/* date picker */}
                    {editSchedType === "date" && (
                      <div className="mb-4">
                        <div className="flex gap-2 mb-2">
                          <input type="date"
                            className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                            onChange={e => { addDate(e.target.value); e.target.value = ""; }}
                          />
                          <span className="text-xs text-slate-500 self-center flex-shrink-0">選日期後自動加入</span>
                        </div>
                        {editSchedDates.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                            {editSchedDates.map(d => (
                              <span key={d}
                                className="flex items-center gap-1 px-2 py-1 bg-indigo-500/20 border border-indigo-500/40 text-indigo-200 text-xs rounded-lg">
                                {d}
                                <button onClick={() => setEditSchedDates(prev => prev.filter(x=>x!==d))}
                                  className="text-indigo-300 hover:text-white leading-none">×</button>
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-600">尚未新增任何日期</p>
                        )}
                      </div>
                    )}

                    {/* 時間選擇 */}
                    <p className="text-xs text-slate-400 mb-2">觸發時間</p>
                    <div className="flex items-center gap-2 mb-4">
                      <select value={editSchedHour} onChange={e => setEditSchedHour(parseInt(e.target.value))}
                        className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500 appearance-none text-center">
                        {Array.from({length:24},(_,i)=>i).map(h=>(
                          <option key={h} value={h}>{String(h).padStart(2,"0")}</option>
                        ))}
                      </select>
                      <span className="text-slate-400 font-bold text-lg">:</span>
                      <select value={editSchedMin} onChange={e => setEditSchedMin(parseInt(e.target.value))}
                        className="flex-1 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-indigo-500 appearance-none text-center">
                        {[0,5,10,15,20,25,30,35,40,45,50,55].map(m=>(
                          <option key={m} value={m}>{String(m).padStart(2,"0")}</option>
                        ))}
                      </select>
                      <span className="text-slate-300 text-sm">
                        {String(editSchedHour).padStart(2,"0")}:{String(editSchedMin).padStart(2,"0")}
                      </span>
                    </div>

                  </>
                )}

                {/* 按鈕列 */}
                <div className="flex gap-2 pt-1">
                  {existingCfg?.active && (
                    <button onClick={() => { saveTimerConfig(action, null); setShowTimerModal(null); }}
                      className="flex-1 py-2.5 rounded-xl bg-red-500/15 border border-red-500/40 text-red-400 text-sm active:bg-red-500/25">
                      停用
                    </button>
                  )}
                  <button onClick={() => setShowTimerModal(null)}
                    className="flex-1 py-2.5 rounded-xl border border-slate-600 text-slate-300 text-sm active:bg-slate-800">
                    取消
                  </button>
                  <button
                    disabled={editTimerMode==="schedule" && editSchedType==="weekday" && editSchedDays.length===0
                           || editTimerMode==="schedule" && editSchedType==="date"    && editSchedDates.length===0}
                    onClick={() => { saveTimerConfig(action, buildCfg()); setShowTimerModal(null); }}
                    className="flex-1 py-2.5 rounded-xl bg-yellow-500 text-slate-900 text-sm font-bold active:bg-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed">
                    啟用
                  </button>
                </div>
              </div>
            </div>
          </PortalModal>
        );
      })()}

      {/* ══ Toast 觸發提示 ══ */}
      {toastMsg && (
        <PortalModal>
          <div
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[999999] pointer-events-none"
            style={{ animation: "toastIn 0.2s ease" }}
          >
            <div className="bg-slate-800/95 border border-slate-600 text-white text-sm font-semibold
              px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 whitespace-nowrap">
              <span className="text-green-400 text-base">✓</span>
              {toastMsg}
            </div>
          </div>
          <style>{`
            @keyframes toastIn {
              from { opacity: 0; transform: translate(-50%, 16px); }
              to   { opacity: 1; transform: translate(-50%, 0); }
            }
            @keyframes timerPulse {
              0%,100% { filter: brightness(1); }
              50%      { filter: brightness(1.35); }
            }
            @keyframes schedPulse {
              0%,100% { filter: brightness(1); }
              50%      { filter: brightness(1.25); }
            }
          `}</style>
        </PortalModal>
      )}
    </div>
  );
}
