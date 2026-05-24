import axios from "axios";

const STORAGE_KEY = "haru88_creds";

interface Creds { clientId: string; apiKey: string; checksumKey: string; }

function loadCreds(): Creds | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveCreds(c: Creds) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /**/ }
}

const api = axios.create({
  baseURL: "/api",
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

let credsFetched = false;

async function ensureCreds() {
  if (credsFetched) return;
  try {
    const res = await axios.get("/api/credentials");
    if (res.data?.success && res.data?.data) {
      saveCreds(res.data.data);
      credsFetched = true;
    }
  } catch { /**/ }
}

api.interceptors.request.use(async (config) => {
  await ensureCreds();
  const creds = loadCreds();
  if (creds?.clientId && creds?.apiKey) {
    config.headers["X-Client-ID"] = creds.clientId;
    config.headers["X-API-Key"]   = creds.apiKey;
  }
  return config;
});

export function clearCredCache() {
  credsFetched = false;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /**/ }
}

export function refreshCreds() {
  credsFetched = false;
}

export default api;
