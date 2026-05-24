<template>
  <div class="settings-page">
    <div class="page-header">
      <h1>{{ $t('settings.title') }}</h1>
      <p class="page-desc">{{ $t('settings.desc') }}</p>
    </div>

    <div class="monitor-hero glass" :class="{ 'is-active': settings.monitor.running }">
      <div class="hero-left">
        <el-icon class="pulse-icon" v-if="settings.monitor.running"><VideoPlay /></el-icon>
        <el-icon v-else><VideoPause /></el-icon>
        <div class="hero-text">
          <h2>Background Transaction Monitor</h2>
          <p>
            Status:
            <el-tag :type="settings.monitor.running ? 'success' : 'info'" effect="dark" round size="small">
              {{ settings.monitor.running ? 'ACTIVE' : 'INACTIVE' }}
            </el-tag>
          </p>
        </div>
      </div>
      <div class="hero-right">
        <el-switch v-model="settings.monitor.running" @change="save" size="large" active-color="#13ce66" inactive-color="#ff4949" />
      </div>
    </div>

    <!-- API Credentials Card -->
    <el-card class="cred-card glass-card" style="margin-bottom: 32px;">
      <template #header>
        <div class="panel-header">
          <el-icon><Key /></el-icon>
          <span>{{ $t('settings.credTitle') }}</span>
          <el-tag type="warning" effect="dark" size="small" round style="margin-left: 8px;">BOT API</el-tag>
        </div>
      </template>
      <p class="cred-desc">{{ $t('settings.credDesc') }}</p>

      <div class="cred-grid" v-if="creds.clientId">
        <div class="cred-row" v-for="item in credFields" :key="item.key">
          <div class="cred-label">{{ $t(`settings.${item.key}`) }}</div>
          <div class="cred-value-row">
            <el-input
              :model-value="item.visible ? creds[item.key as keyof typeof creds] : maskKey(creds[item.key as keyof typeof creds])"
              readonly
              class="cred-input"
              :class="{ 'font-mono': true }"
            >
              <template #suffix>
                <div class="cred-actions">
                  <el-tooltip :content="item.visible ? $t('settings.hide') : $t('settings.show')" placement="top">
                    <el-button text size="small" @click="item.visible = !item.visible" class="action-btn">
                      <el-icon><component :is="item.visible ? Hide : View" /></el-icon>
                    </el-button>
                  </el-tooltip>
                  <el-tooltip :content="$t('settings.copied')" trigger="click" placement="top">
                    <el-button text size="small" @click="copyToClipboard(creds[item.key as keyof typeof creds])" class="action-btn">
                      <el-icon><CopyDocument /></el-icon>
                    </el-button>
                  </el-tooltip>
                  <el-tooltip v-if="item.key !== 'clientId'" :content="$t('settings.regen')" placement="top">
                    <el-button
                      text size="small"
                      :loading="regenLoading === item.key"
                      @click="regenerate(item.key as 'apiKey' | 'checksumKey')"
                      class="action-btn warning"
                    >
                      <el-icon><Refresh /></el-icon>
                    </el-button>
                  </el-tooltip>
                </div>
              </template>
            </el-input>
          </div>
        </div>
      </div>
      <el-skeleton v-else :rows="3" animated />

      <el-divider />
      <div class="cred-usage">
        <p class="usage-title">Cách sử dụng trong bot:</p>
        <pre class="usage-code">// Gọi API lấy giao dịch
const res = await fetch('/api/transactions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Client-ID': '{{ creds.clientId || "your-client-id" }}',
    'X-API-Key': '{{ creds.apiKey ? "••• (copy từ ô trên)" : "your-api-key" }}'
  },
  body: JSON.stringify({ accountNumber, fromDate, toDate })
});

// Xác minh checksum webhook nhận được
import { createHmac } from 'crypto';
const sig = createHmac('sha256', checksumKey).update(rawBody).digest('hex');
const valid = request.headers['x-checksum'] === 'sha256=' + sig;</pre>
      </div>
    </el-card>

    <div class="settings-grid">
      <el-card class="panel glass-card">
        <template #header>
          <div class="panel-header">
            <el-icon><Timer /></el-icon> {{ $t('settings.pollerTitle') }}
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item :label="$t('settings.interval')">
            <el-input-number v-model="settings.monitor.intervalSeconds" :min="10" :max="3600" class="full-width" />
            <div class="help-text">{{ $t('settings.intervalHelp') }}</div>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="panel glass-card" :class="{ 'card-disabled': !settings.telegram.enabled }">
        <template #header>
          <div class="panel-header space-between">
            <div class="integ-title">
              <img v-if="settings.telegram.enabled" src="https://upload.wikimedia.org/wikipedia/commons/8/82/Telegram_logo.svg" alt="TG" class="integ-logo" />
              <el-icon v-else><ChatDotRound /></el-icon>
              <span>Telegram</span>
            </div>
            <el-switch v-model="settings.telegram.enabled" />
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="Bot Token">
            <el-input v-model="settings.telegram.botToken" type="password" show-password placeholder="123456789:ABCdef..." :disabled="!settings.telegram.enabled" />
          </el-form-item>
          <el-form-item label="Chat ID">
            <el-input v-model="settings.telegram.chatId" placeholder="-1001234567890" :disabled="!settings.telegram.enabled" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="panel glass-card" :class="{ 'card-disabled': !settings.discord.enabled }">
        <template #header>
          <div class="panel-header space-between">
            <div class="integ-title">
              <el-icon><Phone /></el-icon>
              <span>Discord</span>
            </div>
            <el-switch v-model="settings.discord.enabled" />
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="Webhook URL">
            <el-input v-model="settings.discord.webhookUrl" placeholder="https://discord.com/api/webhooks/..." :disabled="!settings.discord.enabled" />
          </el-form-item>
        </el-form>
      </el-card>

      <el-card class="panel glass-card webhook-card" :class="{ 'card-disabled': !settings.customWebhook.enabled }">
        <template #header>
          <div class="panel-header space-between">
            <div class="integ-title">
              <el-icon><Link /></el-icon>
              <span>Custom Webhook</span>
              <el-tag type="warning" effect="dark" size="small" round style="margin-left:6px;">HARU88 format</el-tag>
            </div>
            <el-switch v-model="settings.customWebhook.enabled" />
          </div>
        </template>
        <el-form label-position="top">
          <el-form-item label="Webhook URL">
            <div class="webhook-url-row">
              <el-input
                v-model="settings.customWebhook.url"
                placeholder="https://your-bot.com/webhook/haru88"
                :disabled="!settings.customWebhook.enabled"
              />
              <el-button
                type="primary"
                :loading="confirmingWebhook"
                :disabled="!settings.customWebhook.enabled || !settings.customWebhook.url"
                @click="confirmWebhook"
                style="white-space:nowrap;"
              >
                Xác nhận URL
              </el-button>
            </div>
            <div v-if="webhookConfirmResult" class="webhook-confirm-result" :class="webhookConfirmResult.ok ? 'ok' : 'fail'">
              <el-icon><component :is="webhookConfirmResult.ok ? CircleCheck : CircleClose" /></el-icon>
              {{ webhookConfirmResult.msg }}
            </div>
            <div class="help-text">HARU88 sẽ gửi một payload test đến URL này. Nếu server trả về 2xx thì URL được xác nhận và lưu lại.</div>
          </el-form-item>
        </el-form>

        <el-divider style="margin: 12px 0;" />
        <div class="payload-preview">
          <p class="preview-title">Payload mẫu HARU88 sẽ gửi đến webhook của bạn:</p>
          <pre class="preview-code">{{ haru88SamplePayload }}</pre>
        </div>
      </el-card>
    </div>

    <div class="settings-actions glass">
      <el-button @click="testNotification" :loading="testing" :icon="Bell" round size="large">
        {{ $t('settings.testBtn') }}
      </el-button>
      <el-button type="primary" @click="save" :loading="saving" :icon="Select" round size="large">
        {{ $t('settings.saveBtn') }}
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { Timer, ChatDotRound, Phone, Link, Bell, Select, VideoPlay, VideoPause, Key, CopyDocument, Refresh, View, Hide, CircleCheck, CircleClose } from "@element-plus/icons-vue";
import api, { refreshCreds } from "../api";

interface SettingsData {
  telegram: { enabled: boolean; botToken: string; chatId: string };
  discord: { enabled: boolean; webhookUrl: string };
  customWebhook: { enabled: boolean; url: string; secret: string };
  monitor: { intervalSeconds: number; running: boolean };
}

interface ApiCredentials {
  clientId: string;
  apiKey: string;
  checksumKey: string;
}

const { t } = useI18n();
const saving = ref(false);
const testing = ref(false);
const regenLoading = ref<string | null>(null);
const confirmingWebhook = ref(false);
const webhookConfirmResult = ref<{ ok: boolean; msg: string } | null>(null);

const creds = reactive<ApiCredentials>({ clientId: "", apiKey: "", checksumKey: "" });
const credFields = reactive([
  { key: "clientId", visible: true },
  { key: "apiKey", visible: false },
  { key: "checksumKey", visible: false },
]);

const settings = reactive<SettingsData>({
  telegram: { enabled: false, botToken: "", chatId: "" },
  discord: { enabled: false, webhookUrl: "" },
  customWebhook: { enabled: false, url: "", secret: "" },
  monitor: { intervalSeconds: 60, running: false },
});

const maskKey = (val: string) => {
  if (!val) return "";
  return val.slice(0, 6) + "••••••••••••••••••••••••" + val.slice(-4);
};

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(t("settings.copied"));
  } catch {
    ElMessage.error("Không thể sao chép");
  }
};

const regenerate = async (field: "apiKey" | "checksumKey") => {
  try {
    await ElMessageBox.confirm(t("settings.regenConfirm"), t("settings.regen"), {
      confirmButtonText: "OK",
      cancelButtonText: "Huỷ",
      type: "warning",
    });
  } catch {
    return;
  }
  regenLoading.value = field;
  try {
    const res = await api.post("/credentials/regenerate", { field });
    if (res.data?.success) {
      creds[field] = res.data.value;
      refreshCreds();
      ElMessage.success(t("settings.regenSuccess"));
    }
  } catch {
    ElMessage.error(t("settings.regenError"));
  } finally {
    regenLoading.value = null;
  }
};

const loadCredentials = async () => {
  try {
    const res = await api.get("/credentials");
    if (res.data?.success && res.data?.data) {
      Object.assign(creds, res.data.data);
    }
  } catch { /**/ }
};

const loadSettings = async () => {
  try {
    const res = await api.get("/settings");
    if (res.data?.success && res.data?.data) {
      Object.assign(settings, res.data.data);
    }
  } catch {
    ElMessage.error(t("settings.loadError"));
  }
};

const save = async () => {
  saving.value = true;
  try {
    const res = await api.post("/settings", settings);
    if (res.data?.success) ElMessage.success(t("settings.saveSuccess"));
  } catch {
    ElMessage.error(t("settings.saveError"));
  } finally {
    saving.value = false;
  }
};

const testNotification = async () => {
  testing.value = true;
  try {
    const res = await api.post("/monitor/test");
    if (res.data?.success) {
      const wh = res.data.webhook;
      if (wh) {
        if (wh.ok) ElMessage.success(`Thông báo đã gửi! Webhook: HTTP ${wh.status}`);
        else ElMessage.warning(`Telegram/Discord đã gửi. Webhook lỗi: ${wh.error || "non-2xx"}`);
      } else {
        ElMessage.success("Thông báo thử nghiệm đã được gửi!");
      }
    } else {
      ElMessage.error("Gửi thông báo thất bại.");
    }
  } catch {
    ElMessage.error("Lỗi khi gửi thông báo.");
  } finally {
    testing.value = false;
  }
};

const confirmWebhook = async () => {
  if (!settings.customWebhook.url) return;
  confirmingWebhook.value = true;
  webhookConfirmResult.value = null;
  try {
    const res = await api.post("/confirm-webhook", { webhookUrl: settings.customWebhook.url });
    if (res.data?.code === "00") {
      webhookConfirmResult.value = { ok: true, msg: "URL xác nhận thành công! Đã lưu và bật webhook." };
      settings.customWebhook.enabled = true;
      ElMessage.success("Webhook URL đã được xác nhận và lưu!");
    } else {
      webhookConfirmResult.value = { ok: false, msg: res.data?.desc || "Xác nhận thất bại" };
    }
  } catch (err: any) {
    const msg = err.response?.data?.desc || "Không thể kết nối đến webhook URL";
    webhookConfirmResult.value = { ok: false, msg };
  } finally {
    confirmingWebhook.value = false;
  }
};

const haru88SamplePayload = computed(() => JSON.stringify({
  code: "00",
  desc: "success",
  success: true,
  data: {
    orderCode: 123456,
    amount: 500000,
    description: "CHUYEN KHOAN",
    accountNumber: "0912345678",
    reference: "FT26001XXXXXX",
    transactionDateTime: "24/05/2026 10:30:00",
    currency: "VND",
    paymentLinkId: "FT26001XXXXXX",
    code: "00",
    desc: "Thành công",
    counterAccountBankId: "",
    counterAccountBankName: "",
    counterAccountName: "NGUYEN VAN A",
    counterAccountNumber: "",
    virtualAccountName: "",
    virtualAccountNumber: "",
  },
  signature: "hmac_sha256(checksumKey, sorted_data_fields)",
}, null, 2));

onMounted(() => {
  loadSettings();
  loadCredentials();
});
</script>

<style scoped>
.settings-page { padding: 0; width: 100%; padding-bottom: 120px; }
.page-header { margin-bottom: 32px; }
.page-header h1 { font-size: 28px; font-weight: 700; margin: 0 0 8px; background: var(--primary-gradient); background-clip: text; -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.page-desc { color: var(--text-muted); font-size: 14px; }

.monitor-hero {
  display: flex; align-items: center; justify-content: space-between;
  padding: 24px 32px; border-radius: 16px; margin-bottom: 32px;
  border: 1px solid var(--border-color); transition: all 0.3s ease;
}
.monitor-hero.is-active { border-color: var(--el-color-success); box-shadow: 0 0 20px rgba(19, 206, 102, 0.1); }

.hero-left { display: flex; align-items: center; gap: 20px; }
.hero-left .el-icon { font-size: 40px; color: var(--text-muted); }
.monitor-hero.is-active .hero-left .el-icon { color: var(--el-color-success); }
.pulse-icon { animation: pulse 2s infinite; }
.hero-text h2 { margin: 0 0 8px; font-size: 20px; font-weight: 600; color: var(--text-primary); }
.hero-text p { margin: 0; font-size: 14px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }

/* Credentials Card */
.cred-card { border-radius: 12px; border: 1px solid rgba(64, 158, 255, 0.3); background: transparent; margin-bottom: 32px; }
.cred-desc { color: var(--text-muted); font-size: 13px; margin: 0 0 20px; }
.cred-grid { display: flex; flex-direction: column; gap: 16px; }
.cred-row { display: flex; flex-direction: column; gap: 6px; }
.cred-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
.cred-value-row { display: flex; align-items: center; gap: 8px; }
.cred-input { flex: 1; font-family: 'Courier New', monospace; }
.font-mono :deep(.el-input__inner) { font-family: 'Courier New', monospace; font-size: 13px; letter-spacing: 0.5px; }
.cred-actions { display: flex; align-items: center; gap: 2px; padding-right: 4px; }
.action-btn { padding: 4px; }
.action-btn.warning { color: var(--el-color-warning); }

.cred-usage { margin-top: 8px; }
.usage-title { font-size: 13px; color: var(--text-secondary); font-weight: 600; margin: 0 0 8px; }
.usage-code {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  color: #a8c7fa;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
  margin: 0;
}

.webhook-url-row { display: flex; gap: 8px; align-items: center; }
.webhook-confirm-result { display: flex; align-items: center; gap: 6px; font-size: 13px; margin-top: 8px; padding: 8px 12px; border-radius: 6px; }
.webhook-confirm-result.ok { background: rgba(103, 194, 58, 0.1); color: var(--el-color-success); border: 1px solid rgba(103, 194, 58, 0.3); }
.webhook-confirm-result.fail { background: rgba(245, 108, 108, 0.1); color: var(--el-color-danger); border: 1px solid rgba(245, 108, 108, 0.3); }
.payload-preview { margin-top: 4px; }
.preview-title { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 8px; }
.preview-code { background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; font-family: 'Courier New', monospace; font-size: 11px; color: #a8c7fa; line-height: 1.5; overflow-x: auto; white-space: pre; margin: 0; max-height: 220px; overflow-y: auto; }
.webhook-card { grid-column: 1 / -1; }

.settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 24px; }
.glass-card { border-radius: 12px; border: 1px solid var(--border-color); background: transparent; }
.panel-header { font-weight: 600; display: flex; align-items: center; gap: 8px; font-size: 16px; }
.panel-header.space-between { justify-content: space-between; }
.integ-title { display: flex; align-items: center; gap: 10px; }
.integ-logo { width: 18px; height: 18px; }
.card-disabled { opacity: 0.6; filter: grayscale(0.5); }
.full-width { width: 100%; }
.help-text { margin-top: -6px; color: var(--text-muted); font-size: 12px; }

.settings-actions {
  position: fixed; bottom: 0; left: var(--sidebar-width); right: 0;
  padding: 20px 40px; display: flex; justify-content: flex-end; gap: 16px;
  border-top: 1px solid var(--border-color); z-index: 10;
  backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
}

@keyframes pulse {
  0% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.1); opacity: 0.8; }
  100% { transform: scale(1); opacity: 1; }
}

@media (max-width: 768px) {
  .settings-grid { grid-template-columns: 1fr; }
  .settings-actions { left: 0; padding: 16px 24px; }
  .monitor-hero { flex-direction: column; align-items: flex-start; gap: 20px; }
}
</style>
