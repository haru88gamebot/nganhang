<template>
  <div class="api-docs">
    <div class="page-header">
      <h1>{{ $t('api.title') }}</h1>
      <el-tag effect="dark" type="success" round>Base URL: {{ BASE_URL }}</el-tag>
    </div>

    <p class="page-desc">{{ $t('api.desc') }}</p>

    <!-- Tab navigation -->
    <el-tabs v-model="activeTab" class="doc-tabs">

      <!-- ─── TAB 1: API ENDPOINTS ─── -->
      <el-tab-pane label="📡 Endpoints" name="endpoints">
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><el-icon><Lightning /></el-icon> {{ $t('api.quickStart') }}</div>
          </template>
          <div class="code-block">
            <div class="code-header">
              <span>cURL — Đăng nhập & Lấy số dư</span>
              <el-button text size="small" @click="copy(quickStartCode)">Copy</el-button>
            </div>
            <pre><code>{{ quickStartCode }}</code></pre>
          </div>
        </el-card>

        <div v-for="ep in endpoints" :key="ep.method + ep.path" class="endpoint-card">
          <el-card>
            <template #header>
              <div class="endpoint-header">
                <div class="endpoint-title">
                  <el-tag :type="ep.method === 'GET' ? 'success' : 'primary'" effect="dark" size="small" class="method-tag">{{ ep.method }}</el-tag>
                  <code class="endpoint-path">/api{{ ep.path }}</code>
                  <span class="endpoint-desc">{{ ep.description }}</span>
                </div>
                <el-button type="primary" plain size="small" @click="toggleTest(ep.path, ep.reqExample)" :class="{ 'is-active': activeTest === ep.path }">
                  <el-icon class="el-icon--left"><VideoPlay /></el-icon>
                  {{ activeTest === ep.path ? $t('api.closePlayground') : $t('api.testApi') }}
                </el-button>
              </div>
            </template>
            <div class="endpoint-body">
              <el-collapse-transition>
                <div v-show="activeTest === ep.path" class="playground-wrapper">
                  <div class="playground">
                    <div class="pg-header"><el-icon><Monitor /></el-icon> {{ $t('api.playground') }}</div>
                    <div class="pg-body">
                      <div class="pg-request" v-if="ep.method !== 'GET'">
                        <div class="pg-label">{{ $t('api.reqBody') }}</div>
                        <el-input v-model="testPayloads[ep.path]" type="textarea" :rows="6" class="mono-textarea" placeholder="{}" resize="vertical" />
                      </div>
                      <div class="pg-actions">
                        <el-button type="success" @click="sendTest(ep)" :loading="testLoading" class="send-btn">
                          <el-icon class="el-icon--left"><Position /></el-icon>{{ $t('api.sendReq') }}
                        </el-button>
                      </div>
                      <div class="pg-response" v-if="testResponses[ep.path]">
                        <div class="pg-label response-label">
                          <span>{{ $t('api.response') }}</span>
                          <div class="response-meta">
                            <el-tag :type="testResponses[ep.path]?.status === 200 ? 'success' : 'danger'" size="small" effect="dark" round>{{ testResponses[ep.path]?.status }}</el-tag>
                            <span class="response-time">{{ testResponses[ep.path]?.ms }} ms</span>
                          </div>
                        </div>
                        <div class="code-block small response-block">
                          <pre><code>{{ JSON.stringify(testResponses[ep.path]?.data, null, 2) }}</code></pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </el-collapse-transition>
              <div class="param-section" v-if="ep.body">
                <h4>{{ $t('api.reqBody') }}</h4>
                <el-table :data="ep.body" style="width: 100%" size="small">
                  <el-table-column prop="field" :label="$t('api.field')" width="150" />
                  <el-table-column prop="type" :label="$t('api.type')" width="100" />
                  <el-table-column prop="required" :label="$t('api.required')" width="90">
                    <template #default="{ row }">
                      <el-tag :type="row.required ? 'danger' : 'info'" size="small" effect="plain" round>{{ row.required ? $t('api.yes') : $t('api.no') }}</el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column prop="desc" :label="$t('transactions.description')" />
                </el-table>
              </div>
              <div class="example-grid">
                <div class="example-block" v-if="ep.reqExample">
                  <h4>{{ $t('api.reqEx') }}</h4>
                  <div class="code-block small">
                    <div class="code-header"><span>JSON</span><el-button text size="small" @click="copy(ep.reqExample)">Copy</el-button></div>
                    <pre><code>{{ ep.reqExample }}</code></pre>
                  </div>
                </div>
                <div class="example-block">
                  <h4>{{ $t('api.resEx') }}</h4>
                  <div class="code-block small">
                    <div class="code-header"><span>JSON</span><el-button text size="small" @click="copy(ep.resExample)">Copy</el-button></div>
                    <pre><code>{{ ep.resExample }}</code></pre>
                  </div>
                </div>
              </div>
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- ─── TAB: PAYMENT REQUESTS ─── -->
      <el-tab-pane label="💳 Payment Requests" name="payments">

        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><el-icon><Lightning /></el-icon> Luồng hoạt động HARU88</div>
          </template>
          <div class="flow-steps">
            <div class="flow-step"><span class="step-num">1</span><div><b>Merchant tạo đơn hàng</b><br><span class="step-sub">Gọi <code>POST /api/payment-requests</code> với orderCode, amount, description, returnUrl, cancelUrl</span></div></div>
            <div class="flow-arrow">↓</div>
            <div class="flow-step"><span class="step-num">2</span><div><b>Khách hàng chuyển khoản MB Bank</b><br><span class="step-sub">Chuyển đúng <b>số tiền</b> + <b>nội dung</b> = description đã tạo</span></div></div>
            <div class="flow-arrow">↓</div>
            <div class="flow-step"><span class="step-num">3</span><div><b>HARU88 tự động phát hiện</b><br><span class="step-sub">Monitor quét giao dịch MB Bank theo chu kỳ, khớp với đơn hàng PENDING</span></div></div>
            <div class="flow-arrow">↓</div>
            <div class="flow-step"><span class="step-num">4</span><div><b>Tự động gửi Webhook + Thông báo</b><br><span class="step-sub">HARU88 gửi POST đến webhook URL với payload đầy đủ + signature, đồng thời gửi Telegram/Discord</span></div></div>
            <div class="flow-arrow">↓</div>
            <div class="flow-step"><span class="step-num">5</span><div><b>Merchant xác minh & cập nhật đơn hàng</b><br><span class="step-sub">Nhận webhook → verify signature → cập nhật trạng thái → redirect về returnUrl</span></div></div>
          </div>
          <el-alert type="info" :closable="false" style="margin-top:16px;">
            <b>Lưu ý:</b> description trong chuyển khoản phải <b>chứa</b> description đã đăng ký. Ví dụ: đăng ký <code>THANHTOAN803347</code> → khách chuyển nội dung <code>CK THANHTOAN803347</code> → vẫn khớp.
          </el-alert>
        </el-card>

        <!-- API endpoints -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><el-icon><Connection /></el-icon> Các endpoint Payment Requests</div>
          </template>
          <div class="pr-endpoint" v-for="pre in paymentEndpoints" :key="pre.path">
            <div class="pr-ep-header">
              <el-tag :type="pre.method === 'GET' ? 'success' : pre.method === 'PUT' ? 'warning' : 'primary'" effect="dark" size="small" class="method-tag">{{ pre.method }}</el-tag>
              <code class="endpoint-path">/api{{ pre.path }}</code>
              <span class="endpoint-desc">{{ pre.desc }}</span>
            </div>
            <div class="code-block small" style="margin-top:8px;">
              <div class="code-header"><span>{{ pre.method === 'GET' ? 'cURL' : 'cURL + Body' }}</span><el-button text size="small" @click="copy(pre.curl)">Copy</el-button></div>
              <pre><code>{{ pre.curl }}</code></pre>
            </div>
          </div>
        </el-card>

        <!-- Create example with code -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">Node.js</span> Tích hợp hoàn chỉnh</div>
          </template>
          <div class="code-block">
            <div class="code-header"><span>TypeScript / Node.js</span><el-button text size="small" @click="copy(paymentNodeExample)">Copy</el-button></div>
            <pre><code>{{ paymentNodeExample }}</code></pre>
          </div>
        </el-card>

        <!-- Webhook payload for payment matched -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">4</span> Webhook khi khớp đơn hàng</div>
          </template>
          <p class="step-desc">Khi HARU88 phát hiện giao dịch khớp đơn hàng, gửi POST đến webhook URL với payload:</p>
          <div class="code-block small mb-16">
            <div class="code-header"><span>JSON Payload</span><el-button text size="small" @click="copy(paymentWebhookPayload)">Copy</el-button></div>
            <pre><code>{{ paymentWebhookPayload }}</code></pre>
          </div>
          <h4 class="sub-heading">returnUrl redirect sau khi thanh toán:</h4>
          <div class="code-block small">
            <div class="code-header"><span>URL ví dụ</span><el-button text size="small" @click="copy(returnUrlExample)">Copy</el-button></div>
            <pre><code>{{ returnUrlExample }}</code></pre>
          </div>
        </el-card>

      </el-tab-pane>

      <!-- ─── TAB 2: BOT INTEGRATION GUIDE ─── -->
      <el-tab-pane label="🤖 Tích hợp Bot" name="bot">

        <!-- Credentials overview -->
        <el-card class="doc-section" v-if="creds.clientId">
          <template #header>
            <div class="section-title"><el-icon><Key /></el-icon> Thông tin xác thực của bạn</div>
          </template>
          <div class="cred-overview">
            <div class="cred-item" v-for="c in credDisplay" :key="c.label">
              <span class="cred-ov-label">{{ c.label }}</span>
              <div class="cred-ov-val">
                <code>{{ c.masked ? maskKey(creds[c.key as keyof typeof creds]) : creds[c.key as keyof typeof creds] }}</code>
                <el-button text size="small" @click="copy(creds[c.key as keyof typeof creds])"><el-icon><CopyDocument /></el-icon></el-button>
              </div>
            </div>
          </div>
          <el-alert type="warning" :closable="false" style="margin-top:16px;">
            Giữ bí mật <b>API Key</b> và <b>Checksum Key</b>. Nếu lộ, hãy tạo lại trong phần Cài đặt.
          </el-alert>
        </el-card>

        <!-- Step 1: Auth Headers -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">1</span> Headers xác thực</div>
          </template>
          <p class="step-desc">Thêm 2 headers sau vào <b>mọi request</b> gọi đến API:</p>
          <el-table :data="authHeaders" style="width:100%" size="small" class="mb-16">
            <el-table-column prop="header" label="Header" width="200"><template #default="{row}"><code class="mono">{{ row.header }}</code></template></el-table-column>
            <el-table-column prop="value" label="Giá trị" width="200"><template #default="{row}"><code class="mono accent">{{ row.value }}</code></template></el-table-column>
            <el-table-column prop="desc" label="Mô tả" />
          </el-table>
          <div class="code-block">
            <div class="code-header"><span>cURL ví dụ</span><el-button text size="small" @click="copy(authCurlExample)">Copy</el-button></div>
            <pre><code>{{ authCurlExample }}</code></pre>
          </div>
        </el-card>

        <!-- Step 2: Node.js -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">2</span> Tích hợp Node.js / TypeScript</div>
          </template>
          <div class="lang-tabs">
            <el-tabs v-model="nodeTab">
              <el-tab-pane label="Axios" name="axios">
                <div class="code-block">
                  <div class="code-header"><span>TypeScript</span><el-button text size="small" @click="copy(nodeAxiosExample)">Copy</el-button></div>
                  <pre><code>{{ nodeAxiosExample }}</code></pre>
                </div>
              </el-tab-pane>
              <el-tab-pane label="Fetch (built-in)" name="fetch">
                <div class="code-block">
                  <div class="code-header"><span>JavaScript (Node 18+)</span><el-button text size="small" @click="copy(nodeFetchExample)">Copy</el-button></div>
                  <pre><code>{{ nodeFetchExample }}</code></pre>
                </div>
              </el-tab-pane>
            </el-tabs>
          </div>
        </el-card>

        <!-- Step 3: Python -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">3</span> Tích hợp Python</div>
          </template>
          <div class="code-block">
            <div class="code-header"><span>Python 3 (requests)</span><el-button text size="small" @click="copy(pythonExample)">Copy</el-button></div>
            <pre><code>{{ pythonExample }}</code></pre>
          </div>
        </el-card>

        <!-- Step 4: Webhook -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">4</span> Nhận & xác minh Webhook</div>
          </template>
          <p class="step-desc">
            Khi monitor phát hiện giao dịch mới, server sẽ gửi <code>POST</code> đến URL webhook của bạn với các headers:
          </p>
          <el-table :data="webhookHeaders" style="width:100%" size="small" class="mb-16">
            <el-table-column prop="header" label="Header" width="220"><template #default="{row}"><code class="mono">{{ row.header }}</code></template></el-table-column>
            <el-table-column prop="example" label="Ví dụ" width="300"><template #default="{row}"><code class="mono accent">{{ row.example }}</code></template></el-table-column>
            <el-table-column prop="desc" label="Mô tả" />
          </el-table>

          <h4 class="sub-heading">Payload JSON giao dịch:</h4>
          <div class="code-block small mb-16">
            <div class="code-header"><span>JSON</span><el-button text size="small" @click="copy(webhookPayload)">Copy</el-button></div>
            <pre><code>{{ webhookPayload }}</code></pre>
          </div>

          <h4 class="sub-heading">Xác minh checksum (Node.js):</h4>
          <div class="code-block mb-16">
            <div class="code-header"><span>Express.js webhook receiver</span><el-button text size="small" @click="copy(webhookNodeExample)">Copy</el-button></div>
            <pre><code>{{ webhookNodeExample }}</code></pre>
          </div>

          <h4 class="sub-heading">Xác minh checksum (Python):</h4>
          <div class="code-block">
            <div class="code-header"><span>FastAPI / Flask webhook receiver</span><el-button text size="small" @click="copy(webhookPythonExample)">Copy</el-button></div>
            <pre><code>{{ webhookPythonExample }}</code></pre>
          </div>
        </el-card>

        <!-- Step 5: Telegram bot full example -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><span class="step-badge">5</span> Ví dụ: Bot Telegram nhận biến động số dư</div>
          </template>
          <p class="step-desc">Bot Telegram tự động gửi tin nhắn khi nhận webhook từ HARU88:</p>
          <div class="code-block">
            <div class="code-header"><span>Node.js + Telegraf + Express</span><el-button text size="small" @click="copy(telegramBotExample)">Copy</el-button></div>
            <pre><code>{{ telegramBotExample }}</code></pre>
          </div>
        </el-card>

      </el-tab-pane>

      <!-- ─── TAB: SDKs ─── -->
      <el-tab-pane label="📦 SDKs" name="sdk">

        <!-- Node.js SDK -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title">
              <el-icon><Connection /></el-icon> HARU88 Node.js SDK
              <el-tag type="success" effect="dark" size="small" round style="margin-left:6px;">Server-side</el-tag>
            </div>
          </template>
          <p class="step-desc">Tích hợp HARU88 vào backend Node.js / TypeScript chỉ với vài dòng code.</p>

          <h4 class="sub-heading">Cài đặt</h4>
          <div class="code-block small mb-16">
            <div class="code-header">
              <span>Terminal</span>
              <el-button text size="small" @click="copy(`curl -o haru88-node.ts ${BASE_URL}/sdk/node`)">Copy</el-button>
            </div>
            <pre><code># Tải SDK về project của bạn
curl -o haru88-node.ts {{ BASE_URL }}/sdk/node

# Hoặc mở trực tiếp trong trình duyệt:
# {{ BASE_URL }}/sdk/node</code></pre>
          </div>

          <h4 class="sub-heading">Khởi tạo</h4>
          <div class="code-block small mb-16">
            <div class="code-header"><span>TypeScript</span><el-button text size="small" @click="copy(sdkInitExample)">Copy</el-button></div>
            <pre><code>{{ sdkInitExample }}</code></pre>
          </div>

          <h4 class="sub-heading">Tạo đơn hàng & nhận webhook</h4>
          <div class="code-block mb-16">
            <div class="code-header"><span>TypeScript / Express.js</span><el-button text size="small" @click="copy(sdkFullExample)">Copy</el-button></div>
            <pre><code>{{ sdkFullExample }}</code></pre>
          </div>

          <h4 class="sub-heading">Tất cả methods</h4>
          <el-table :data="sdkMethods" style="width:100%" size="small">
            <el-table-column prop="method" label="Method" width="320"><template #default="{row}"><code class="mono accent">{{ row.method }}</code></template></el-table-column>
            <el-table-column prop="desc" label="Mô tả" />
            <el-table-column prop="returns" label="Trả về" width="180"><template #default="{row}"><code class="mono" style="font-size:11px;">{{ row.returns }}</code></template></el-table-column>
          </el-table>
        </el-card>

        <!-- Web SDK -->
        <el-card class="doc-section">
          <template #header>
            <div class="section-title">
              <el-icon><Monitor /></el-icon> HARU88 Web Checkout SDK
              <el-tag type="primary" effect="dark" size="small" round style="margin-left:6px;">Browser</el-tag>
            </div>
          </template>
          <p class="step-desc">Nhúng giao diện thanh toán ngay trong trang web — khách nhập thông tin chuyển khoản, SDK tự polling cho đến khi thanh toán thành công.</p>

          <h4 class="sub-heading">Cài đặt (thêm vào HTML)</h4>
          <div class="code-block small mb-16">
            <div class="code-header"><span>HTML</span><el-button text size="small" @click="copy(`<script src=\'${BASE_URL}/sdk/web\'><\/script>`)">Copy</el-button></div>
            <pre><code>&lt;!-- Thêm vào &lt;head&gt; hoặc cuối &lt;body&gt; --&gt;
&lt;script src="{{ BASE_URL }}/sdk/web"&gt;&lt;/script&gt;

&lt;!-- Container hiển thị giao diện thanh toán --&gt;
&lt;div id="payment-container"&gt;&lt;/div&gt;</code></pre>
          </div>

          <h4 class="sub-heading">Sử dụng</h4>
          <div class="code-block mb-16">
            <div class="code-header"><span>JavaScript (Browser)</span><el-button text size="small" @click="copy(webSdkExample)">Copy</el-button></div>
            <pre><code>{{ webSdkExample }}</code></pre>
          </div>

          <h4 class="sub-heading">Cấu hình HARU88Checkout.useHARU88(config)</h4>
          <el-table :data="webSdkConfig" style="width:100%" size="small">
            <el-table-column prop="field" label="Field" width="200"><template #default="{row}"><code class="mono">{{ row.field }}</code></template></el-table-column>
            <el-table-column prop="type" label="Type" width="100"><template #default="{row}"><code class="mono accent">{{ row.type }}</code></template></el-table-column>
            <el-table-column prop="required" label="Bắt buộc" width="90">
              <template #default="{ row }">
                <el-tag :type="row.required ? 'danger' : 'info'" size="small" effect="plain" round>{{ row.required ? 'Có' : 'Không' }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="desc" label="Mô tả" />
          </el-table>
        </el-card>

      </el-tab-pane>

      <!-- ─── TAB 3: FULL EXAMPLE ─── -->
      <el-tab-pane label="⚡ Ví dụ đầy đủ" name="full">
        <el-card class="doc-section">
          <template #header>
            <div class="section-title"><el-icon><Connection /></el-icon> {{ $t('api.fullEx') }}</div>
          </template>
          <div class="code-block">
            <div class="code-header"><span>TypeScript (Node.js)</span><el-button text size="small" @click="copy(fullExample)">Copy</el-button></div>
            <pre><code>{{ fullExample }}</code></pre>
          </div>
        </el-card>
      </el-tab-pane>

    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue";
import { ElMessage } from "element-plus";
import { Lightning, Connection, VideoPlay, Monitor, Position, Key, CopyDocument } from "@element-plus/icons-vue";
import api from "../api";

const activeTab = ref("endpoints");
const nodeTab = ref("axios");

const copy = async (text: string) => {
  try { await navigator.clipboard.writeText(text); ElMessage.success("Đã sao chép!"); }
  catch { ElMessage.error("Sao chép thất bại"); }
};

const activeTest = ref<string | null>(null);
const testPayloads = reactive<Record<string, string>>({});
const testResponses = reactive<Record<string, { status: number; data: any; ms: number } | null>>({});
const testLoading = ref(false);

interface ApiCreds { clientId: string; apiKey: string; checksumKey: string; }
const creds = reactive<ApiCreds>({ clientId: "", apiKey: "", checksumKey: "" });
const credDisplay = [
  { label: "Client ID", key: "clientId", masked: false },
  { label: "API Key", key: "apiKey", masked: true },
  { label: "Checksum Key", key: "checksumKey", masked: true },
];

const maskKey = (v: string) => v ? v.slice(0, 8) + "••••••••••••••••••••" + v.slice(-6) : "";

onMounted(async () => {
  try {
    const res = await api.get("/credentials");
    if (res.data?.success) Object.assign(creds, res.data.data);
  } catch { /**/ }
});

const toggleTest = (path: string, defaultPayload: string | null) => {
  activeTest.value = activeTest.value === path ? null : path;
  if (activeTest.value && !testPayloads[path]) testPayloads[path] = defaultPayload || "{}\n";
};

const sendTest = async (ep: any) => {
  testLoading.value = true;
  const start = Date.now();
  try {
    let payload = undefined;
    if (ep.method !== "GET") {
      try { payload = JSON.parse(testPayloads[ep.path] || "{}"); }
      catch { ElMessage.error("JSON không hợp lệ"); testLoading.value = false; return; }
    }
    const res = ep.method === "GET" ? await api.get(ep.path) : await api.post(ep.path, payload);
    testResponses[ep.path] = { status: res.status, data: res.data, ms: Date.now() - start };
  } catch (err: any) {
    testResponses[ep.path] = { status: err.response?.status || 500, data: err.response?.data || { success: false, message: err.message }, ms: Date.now() - start };
  } finally { testLoading.value = false; }
};

const BASE_URL = window.location.origin + "/api";
const CLIENT_ID = creds.clientId || "haru88-xxxxxxxxxxxxxxxx";
const API_KEY = "YOUR_API_KEY";
const CHECKSUM_KEY = "YOUR_CHECKSUM_KEY";

const quickStartCode = `# 1. Đăng nhập (captcha tự động OCR — không cần headers xác thực)
curl -X POST ${BASE_URL}/login \\
  -H "Content-Type: application/json" \\
  -d '{"username": "0912345678", "password": "your_password"}'

# 2. Lấy số dư (cần X-Client-ID + X-API-Key)
curl -X POST ${BASE_URL}/balance \\
  -H "Content-Type: application/json" \\
  -H "X-Client-ID: haru88-xxxxxxxxxxxxxxxx" \\
  -H "X-API-Key: YOUR_API_KEY"

# 3. Lịch sử giao dịch
curl -X POST ${BASE_URL}/transactions \\
  -H "Content-Type: application/json" \\
  -H "X-Client-ID: haru88-xxxxxxxxxxxxxxxx" \\
  -H "X-API-Key: YOUR_API_KEY" \\
  -d '{"accountNumber": "0912345678", "fromDate": "01/03/2026", "toDate": "27/03/2026"}'`;

const authHeaders = [
  { header: "X-Client-ID", value: CLIENT_ID, desc: "Client ID lấy từ trang Cài đặt" },
  { header: "X-API-Key", value: "bc19d6...df96", desc: "API Key lấy từ trang Cài đặt" },
];

const authCurlExample = `curl -X POST ${BASE_URL}/balance \\
  -H "Content-Type: application/json" \\
  -H "X-Client-ID: ${CLIENT_ID}" \\
  -H "X-API-Key: ${API_KEY}"`;

const nodeAxiosExample = `import axios from "axios";
import { createHmac } from "crypto";

const CLIENT_ID   = "haru88-xxxxxxxxxxxxxxxx"; // từ Cài đặt
const API_KEY     = "bc19d6...";               // từ Cài đặt
const CHECKSUM_KEY = "e851c3...";              // từ Cài đặt

const haru = axios.create({
  baseURL: "${BASE_URL}",
  headers: {
    "Content-Type": "application/json",
    "X-Client-ID": CLIENT_ID,
    "X-API-Key":   API_KEY,
  },
});

// ── Đăng nhập ──────────────────────────────────────────
async function login(username: string, password: string) {
  const { data } = await haru.post("/login", { username, password });
  if (!data.success) throw new Error(data.message);
  console.log("✅ Đăng nhập thành công sau", data.attempts, "lần thử");
  return data;
}

// ── Lấy số dư ──────────────────────────────────────────
async function getBalance() {
  const { data } = await haru.post("/balance");
  if (!data.success) throw new Error(data.message);
  return data.data; // { totalBalance, accounts[] }
}

// ── Lịch sử giao dịch ──────────────────────────────────
async function getTransactions(accountNumber: string, from: string, to: string) {
  const { data } = await haru.post("/transactions", {
    accountNumber,
    fromDate: from, // "DD/MM/YYYY"
    toDate:   to,
  });
  if (!data.success) throw new Error(data.message);
  return data.data; // Transaction[]
}

// ── Ví dụ sử dụng ──────────────────────────────────────
async function main() {
  await login("0912345678", "your_password");

  const balance = await getBalance();
  console.log("Tổng số dư:", balance.totalBalance.toLocaleString("vi-VN"), "₫");

  for (const acct of balance.accounts) {
    console.log(\`  STK \${acct.number}: \${acct.balance.toLocaleString("vi-VN")} ₫\`);

    const txs = await getTransactions(acct.number, "01/05/2026", "31/05/2026");
    console.log("  Số giao dịch:", txs.length);
  }
}

main().catch(console.error);`;

const nodeFetchExample = `const CLIENT_ID    = "haru88-xxxxxxxxxxxxxxxx";
const API_KEY      = "bc19d6...";
const BASE         = "${BASE_URL}";

const headers = {
  "Content-Type": "application/json",
  "X-Client-ID":  CLIENT_ID,
  "X-API-Key":    API_KEY,
};

// Đăng nhập
const loginRes = await fetch(\`\${BASE}/login\`, {
  method: "POST", headers,
  body: JSON.stringify({ username: "0912345678", password: "your_password" }),
});
const loginData = await loginRes.json();
console.log(loginData.success ? "✅ Logged in" : "❌ " + loginData.message);

// Lấy giao dịch
const txRes = await fetch(\`\${BASE}/transactions\`, {
  method: "POST", headers,
  body: JSON.stringify({
    accountNumber: "0912345678",
    fromDate: "01/05/2026",
    toDate:   "31/05/2026",
  }),
});
const { data: transactions } = await txRes.json();
console.log("Giao dịch:", transactions.length);`;

const pythonExample = `import requests
import hmac, hashlib, json

CLIENT_ID    = "haru88-xxxxxxxxxxxxxxxx"  # từ Cài đặt
API_KEY      = "bc19d6..."               # từ Cài đặt
CHECKSUM_KEY = "e851c3..."               # từ Cài đặt
BASE_URL     = "${BASE_URL}"

SESSION = requests.Session()
SESSION.headers.update({
    "Content-Type": "application/json",
    "X-Client-ID":  CLIENT_ID,
    "X-API-Key":    API_KEY,
})

def login(username: str, password: str) -> dict:
    r = SESSION.post(f"{BASE_URL}/login", json={"username": username, "password": password})
    r.raise_for_status()
    data = r.json()
    if not data["success"]:
        raise Exception(data["message"])
    print(f"✅ Đăng nhập thành công sau {data['attempts']} lần thử")
    return data

def get_balance() -> dict:
    r = SESSION.post(f"{BASE_URL}/balance")
    r.raise_for_status()
    return r.json()["data"]

def get_transactions(account_number: str, from_date: str, to_date: str) -> list:
    r = SESSION.post(f"{BASE_URL}/transactions", json={
        "accountNumber": account_number,
        "fromDate": from_date,  # "DD/MM/YYYY"
        "toDate":   to_date,
    })
    r.raise_for_status()
    return r.json()["data"]

def verify_checksum(raw_body: bytes, signature: str) -> bool:
    """Xác minh X-Checksum header từ webhook"""
    expected = "sha256=" + hmac.new(
        CHECKSUM_KEY.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)

# ── Ví dụ sử dụng ──────────────────────────────
login("0912345678", "your_password")

balance = get_balance()
print(f"Tổng số dư: {balance['totalBalance']:,} ₫")

for acct in balance["accounts"]:
    txs = get_transactions(acct["number"], "01/05/2026", "31/05/2026")
    print(f"STK {acct['number']}: {len(txs)} giao dịch")`;

// ──────────────────────────────────────────────────────────────────────────────
// HARU88 gửi envelope có chữ ký trong body (KHÔNG phải header X-Checksum)
// Signature = HMAC-SHA256(checksumKey, sort_alphabet(data fields as key=value&...))
// ──────────────────────────────────────────────────────────────────────────────
const webhookPayload = `// HARU88 gửi POST đến webhook URL của bạn với body sau:
{
  "code": "00",
  "desc": "success",
  "success": true,
  "data": {
    "orderCode": 260001,
    "amount": 500000,
    "description": "NGUYEN VAN A chuyen khoan",
    "accountNumber": "0912345678",
    "reference": "FT260001XXXXXX",
    "transactionDateTime": "24/05/2026 10:30:00",
    "currency": "VND",
    "paymentLinkId": "FT260001XXXXXX",
    "code": "00",
    "desc": "Thành công",
    "counterAccountBankId": "",
    "counterAccountBankName": "",
    "counterAccountName": "NGUYEN VAN A",
    "counterAccountNumber": "",
    "virtualAccountName": "",
    "virtualAccountNumber": ""
  },
  "signature": "abc123def456..."
}

// ⚠️ signature được tính từ các field trong "data":
// 1. Sort key alphabetically
// 2. Nối: "accountNumber=0912345678&amount=500000&code=00&..."
// 3. HMAC-SHA256 với Checksum Key của bạn`;

const webhookHeaders = [
  { header: "Content-Type", example: "application/json", desc: "Kiểu nội dung" },
  { header: "X-Client-ID", example: CLIENT_ID, desc: "Client ID để nhận biết nguồn gửi từ HARU88" },
];

const webhookNodeExample = `import express from "express";
import { createHmac, timingSafeEqual } from "crypto";

const CHECKSUM_KEY = "YOUR_CHECKSUM_KEY"; // lấy từ Cài đặt HARU88
const app = express();
app.use(express.json());

// Hàm xác minh signature HARU88
function verifySignature(data: Record<string, unknown>, signature: string, key: string): boolean {
  // 1. Sort các key trong data theo alphabet
  // 2. Tạo chuỗi "key=value&key=value..."
  const sortedStr = Object.keys(data)
    .sort()
    .map(k => \`\${k}=\${data[k] ?? ""}\`)
    .join("&");

  // 3. HMAC-SHA256 với Checksum Key
  const expected = createHmac("sha256", key).update(sortedStr).digest("hex");

  // 4. So sánh an toàn (chống timing attack)
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

app.post("/webhook/haru88", (req, res) => {
  const { code, success, data, signature } = req.body;

  // Xác minh nguồn gửi từ HARU88
  if (!signature || !data) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  if (!verifySignature(data, signature, CHECKSUM_KEY)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // ✅ Payload hợp lệ — xử lý giao dịch
  const isCredit = data.amount > 0 && code === "00";
  console.log(\`💰 \${isCredit ? "+" : "-"}\${Number(data.amount).toLocaleString("vi-VN")} ₫\`);
  console.log(\`📝 \${data.description}\`);
  console.log(\`🔖 Mã GD: \${data.reference}\`);
  console.log(\`👤 Người gửi: \${data.counterAccountName}\`);
  console.log(\`📅 \${data.transactionDateTime}\`);

  // Trả về 200 để HARU88 biết đã nhận thành công
  res.json({ received: true });
});

app.listen(3000, () => console.log("✅ Webhook server running on :3000"));`;

const webhookPythonExample = `from fastapi import FastAPI, Request, HTTPException
import hmac, hashlib, json

CHECKSUM_KEY = "YOUR_CHECKSUM_KEY"  # lấy từ Cài đặt HARU88
app = FastAPI()

def verify_signature(data: dict, signature: str, key: str) -> bool:
    """Xác minh signature HARU88 — sort key alpha, HMAC-SHA256"""
    sorted_str = "&".join(
        f"{k}={data.get(k, '')}"
        for k in sorted(data.keys())
    )
    expected = hmac.new(key.encode(), sorted_str.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)

@app.post("/webhook/haru88")
async def receive_webhook(request: Request):
    body = await request.json()
    data      = body.get("data", {})
    signature = body.get("signature", "")

    if not data or not signature:
        raise HTTPException(status_code=400, detail="Invalid payload")

    if not verify_signature(data, signature, CHECKSUM_KEY):
        raise HTTPException(status_code=401, detail="Invalid signature")

    # ✅ Hợp lệ — xử lý giao dịch
    amount = data.get("amount", 0)
    print(f"💰 +{amount:,} ₫")
    print(f"📝 {data.get('description')}")
    print(f"🔖 Mã GD: {data.get('reference')}")
    print(f"👤 Người gửi: {data.get('counterAccountName')}")

    return {"received": True}`;

const telegramBotExample = `import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import TelegramBot from "node-telegram-bot-api"; // npm i node-telegram-bot-api

const CHECKSUM_KEY   = "YOUR_CHECKSUM_KEY";  // từ Cài đặt HARU88
const TELEGRAM_TOKEN = "123456:ABC...";       // BotFather token
const CHAT_ID        = "-1001234567890";      // ID group/channel nhận thông báo

const bot = new TelegramBot(TELEGRAM_TOKEN);
const app = express();
app.use(express.json());

// ── Xác minh signature HARU88 ───────────────────────────────────────────────
function verifySignature(data: any, sig: string): boolean {
  const str = Object.keys(data).sort().map(k => \`\${k}=\${data[k] ?? ""}\`).join("&");
  const exp = createHmac("sha256", CHECKSUM_KEY).update(str).digest("hex");
  try { return timingSafeEqual(Buffer.from(exp), Buffer.from(sig)); }
  catch { return false; }
}

// ── Nhận webhook từ HARU88 ──────────────────────────────────────────────────
app.post("/webhook/haru88", async (req, res) => {
  const { code, data, signature } = req.body;

  if (!verifySignature(data, signature)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ✅ Giao dịch hợp lệ — gửi thông báo Telegram
  const fmt = (n: number) => n.toLocaleString("vi-VN") + " ₫";
  const msg =
    \`🟢 <b>BIẾN ĐỘNG SỐ DƯ — HARU88</b>\n\n\` +
    \`🏦 <b>STK:</b> <code>\${data.accountNumber}</code>\n\` +
    \`💰 <b>Số tiền:</b> +\${fmt(data.amount)}\n\` +
    \`📝 <b>Nội dung:</b> <i>\${data.description}</i>\n\` +
    \`👤 <b>Người gửi:</b> \${data.counterAccountName || "N/A"}\n\` +
    \`🔖 <b>Mã GD:</b> <code>\${data.reference}</code>\n\` +
    \`📅 \${data.transactionDateTime}\`;

  await bot.sendMessage(CHAT_ID, msg, { parse_mode: "HTML" });

  res.json({ ok: true });
});

app.listen(3001, () => console.log("🤖 HARU88 bot webhook listening on :3001"));`;

const fullExample = `import axios from "axios";

const API = axios.create({
  baseURL: "${BASE_URL}",
  headers: {
    "Content-Type": "application/json",
    "X-Client-ID": "haru88-xxxxxxxxxxxxxxxx",
    "X-API-Key":   "bc19d6...",
  },
});

async function main() {
  // Đăng nhập
  const { data: loginRes } = await API.post("/login", {
    username: "0912345678",
    password: "your_password",
  });
  if (!loginRes.success) { console.error("Login failed:", loginRes.message); return; }

  // Lấy số dư
  const { data: balanceRes } = await API.post("/balance");
  console.log("Total Balance:", balanceRes.data.totalBalance, "VND");

  // Lấy lịch sử giao dịch tài khoản đầu tiên
  const firstAccount = balanceRes.data.accounts[0];
  const { data: txRes } = await API.post("/transactions", {
    accountNumber: firstAccount.number,
    fromDate: "01/05/2026",
    toDate:   "31/05/2026",
  });
  console.log("Transactions:", txRes.data.length);
}

main();`;

// ── Payment Requests data ─────────────────────────────────────────────────────
const paymentEndpoints = [
  {
    method: "POST",
    path: "/payment-requests",
    desc: "Tạo đơn hàng mới (PENDING)",
    curl: `curl -X POST ${BASE_URL}/payment-requests \\
  -H "Content-Type: application/json" \\
  -H "X-Client-ID: ${CLIENT_ID}" \\
  -H "X-API-Key: ${API_KEY}" \\
  -d '{
    "orderCode": 803347,
    "amount": 50000,
    "description": "THANHTOAN803347",
    "returnUrl": "https://your-site.com/return?orderCode=803347",
    "cancelUrl": "https://your-site.com/cancel",
    "expireInMinutes": 15
  }'`,
  },
  {
    method: "GET",
    path: "/payment-requests/:orderCode",
    desc: "Kiểm tra trạng thái đơn hàng",
    curl: `curl ${BASE_URL}/payment-requests/803347 \\
  -H "X-Client-ID: ${CLIENT_ID}" \\
  -H "X-API-Key: ${API_KEY}"`,
  },
  {
    method: "GET",
    path: "/payment-requests",
    desc: "Danh sách tất cả đơn hàng",
    curl: `curl ${BASE_URL}/payment-requests \\
  -H "X-Client-ID: ${CLIENT_ID}" \\
  -H "X-API-Key: ${API_KEY}"`,
  },
  {
    method: "PUT",
    path: "/payment-requests/:orderCode/cancel",
    desc: "Hủy đơn hàng PENDING",
    curl: `curl -X PUT ${BASE_URL}/payment-requests/803347/cancel \\
  -H "X-Client-ID: ${CLIENT_ID}" \\
  -H "X-API-Key: ${API_KEY}"`,
  },
];

const paymentNodeExample = `import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";

const CLIENT_ID    = "haru88-xxxxxxxxxxxxxxxx"; // từ Cài đặt
const API_KEY      = "bc19d6...";               // từ Cài đặt
const CHECKSUM_KEY = "e851c3...";               // từ Cài đặt (để verify webhook)

const haru = axios.create({
  baseURL: "${BASE_URL}",
  headers: { "Content-Type": "application/json", "X-Client-ID": CLIENT_ID, "X-API-Key": API_KEY },
});

// ── BƯỚC 1: Tạo đơn hàng ─────────────────────────────────────────────────────
async function createOrder(orderCode: number, amount: number) {
  const { data } = await haru.post("/payment-requests", {
    orderCode,
    amount,
    description: \`THANHTOAN\${orderCode}\`,  // khách phải ghi nội dung này khi CK
    returnUrl: \`https://your-site.com/return?orderCode=\${orderCode}\`,
    cancelUrl: \`https://your-site.com/cancel?orderCode=\${orderCode}\`,
    expireInMinutes: 15,
  });
  if (data.code !== "00") throw new Error(data.desc);
  console.log("✅ Đơn hàng tạo xong:", data.data.id);
  // Hiển thị thông tin chuyển khoản cho khách:
  console.log(\`   Số tiền: \${amount.toLocaleString("vi-VN")} ₫\`);
  console.log(\`   Nội dung CK: THANHTOAN\${orderCode}\`);
  return data.data;
}

// ── BƯỚC 2: Kiểm tra trạng thái (polling) ────────────────────────────────────
async function checkStatus(orderCode: number) {
  const { data } = await haru.get(\`/payment-requests/\${orderCode}\`);
  return data.data.status; // "PENDING" | "PAID" | "CANCELLED"
}

// ── BƯỚC 3: Nhận Webhook khi thanh toán xong ─────────────────────────────────
// (Express.js)
import express from "express";
const app = express();
app.use(express.json());

function verifySignature(data: any, sig: string): boolean {
  const str = Object.keys(data).sort().map(k => \`\${k}=\${data[k] ?? ""}\`).join("&");
  const exp = createHmac("sha256", CHECKSUM_KEY).update(str).digest("hex");
  try { return timingSafeEqual(Buffer.from(exp), Buffer.from(sig)); } catch { return false; }
}

app.post("/webhook/haru88", (req, res) => {
  const { data, signature } = req.body;
  if (!verifySignature(data, signature)) return res.status(401).json({ error: "Unauthorized" });

  if (data.status === "PAID") {
    console.log(\`✅ Đơn \${data.orderCode} đã thanh toán: \${data.amount.toLocaleString("vi-VN")} ₫\`);
    // TODO: cập nhật DB, gửi email xác nhận, ...
    // Redirect khách về returnUrl (nếu dùng polling ở frontend)
  }
  res.json({ received: true });
});

// ── BƯỚC 4: Handle returnUrl ──────────────────────────────────────────────────
// Khi HARU88 gọi returnUrl, URL sẽ có dạng:
// https://your-site.com/return?orderCode=803347&status=PAID&id=abc123...
app.get("/return", async (req, res) => {
  const { orderCode, status, id } = req.query;
  if (status === "PAID") {
    res.send(\`<h1>✅ Thanh toán thành công! Đơn hàng #\${orderCode}</h1>\`);
  } else {
    res.send(\`<h1>❌ Đơn hàng #\${orderCode} - \${status}</h1>\`);
  }
});`;

const paymentWebhookPayload = `// HARU88 gửi POST đến webhook URL của bạn khi khớp đơn hàng:
{
  "code": "00",
  "desc": "success",
  "success": true,
  "data": {
    "orderCode": 803347,
    "amount": 50000,
    "description": "THANHTOAN803347",
    "accountNumber": "0912345678",
    "reference": "FT260001XXXXXX",
    "transactionDateTime": "24/05/2026 10:30:00",
    "currency": "VND",
    "paymentLinkId": "a1b2c3d4e5f6...",
    "code": "00",
    "desc": "Thành công",
    "counterAccountName": "NGUYEN VAN A",
    "status": "PAID",
    "returnUrl": "https://your-site.com/return?orderCode=803347",
    "cancelUrl": "https://your-site.com/cancel",
    ...
  },
  "signature": "hmac_sha256_của_data_fields_sort_alphabet"
}`;

const returnUrlExample = `// HARU88 redirect về returnUrl với query params:
https://your-site.com/return?orderCode=803347&status=PAID&id=a1b2c3d4...&code=00

// Nếu hủy → cancelUrl:
https://your-site.com/cancel?orderCode=803347&status=CANCELLED&id=a1b2c3d4...&code=00

// Query params:
// code    — "00" = thành công
// id      — Payment Link ID (HARU88 internal)
// status  — PAID | PENDING | CANCELLED
// orderCode — mã đơn hàng của merchant`;

// ── SDK tab data ─────────────────────────────────────────────────────────────
const sdkInitExample = `import { HARU88 } from "./haru88-node"; // file vừa tải về

const haru88 = new HARU88({
  clientId:    process.env.HARU88_CLIENT_ID!,
  apiKey:      process.env.HARU88_API_KEY!,
  checksumKey: process.env.HARU88_CHECKSUM_KEY!,
  baseUrl:     process.env.HARU88_BASE_URL!,  // "https://your-domain.com/api"
});`;

const sdkFullExample = `import express from "express";
import { HARU88 } from "./haru88-node";

const haru88 = new HARU88({
  clientId:    process.env.HARU88_CLIENT_ID!,
  apiKey:      process.env.HARU88_API_KEY!,
  checksumKey: process.env.HARU88_CHECKSUM_KEY!,
  baseUrl:     "https://your-domain.com/api",
});

// ── Tạo đơn hàng ─────────────────────────────────────────────────────────────
const app = express();

app.post("/create-order", async (req, res) => {
  const { orderCode, amount } = req.body;
  try {
    const pr = await haru88.paymentRequests.create({
      orderCode,
      amount,
      description: \`THANHTOAN\${orderCode}\`,
      returnUrl:   \`https://your-site.com/return?orderCode=\${orderCode}\`,
      cancelUrl:   \`https://your-site.com/cancel?orderCode=\${orderCode}\`,
      expireInMinutes: 15,
    });
    // Trả về thông tin để hiển thị cho khách chuyển khoản
    res.json({
      orderCode:   pr.orderCode,
      amount:      pr.amount,
      description: pr.description,  // khách ghi nội dung này
      expiredAt:   pr.expiredAt,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Kiểm tra trạng thái ───────────────────────────────────────────────────────
app.get("/order-status/:orderCode", async (req, res) => {
  const pr = await haru88.paymentRequests.get(+req.params.orderCode);
  res.json({ status: pr.status, paidAt: pr.paidAt });
});

// ── Nhận Webhook khi thanh toán xong ─────────────────────────────────────────
app.use(express.json());
app.post("/webhook/haru88", (req, res) => {
  try {
    const data = haru88.webhooks.verify(req.body);
    // ✅ Signature hợp lệ — xử lý đơn hàng
    if (data.status === "PAID") {
      console.log(\`Đơn #\${data.orderCode} đã thanh toán \${data.amount.toLocaleString("vi-VN")} ₫\`);
      // updateOrderInDB(data.orderCode, "PAID");
    }
    res.json({ received: true });
  } catch (err: any) {
    // Signature không hợp lệ → từ chối
    res.status(401).json({ error: err.message });
  }
});`;

const sdkMethods = [
  { method: "paymentRequests.create(data)",       desc: "Tạo đơn hàng mới (PENDING)",            returns: "Promise<PaymentRequest>" },
  { method: "paymentRequests.get(orderCode)",     desc: "Lấy trạng thái đơn theo orderCode",      returns: "Promise<PaymentRequest>" },
  { method: "paymentRequests.list()",             desc: "Danh sách tất cả đơn hàng",              returns: "Promise<PaymentRequest[]>" },
  { method: "paymentRequests.cancel(orderCode)",  desc: "Hủy đơn PENDING",                        returns: "Promise<PaymentRequest>" },
  { method: "webhooks.verify(payload)",           desc: "Xác minh signature + trả về WebhookData", returns: "WebhookData" },
  { method: "monitor.status()",                   desc: "Kiểm tra trạng thái server HARU88",      returns: "Promise<{status, loggedIn}>" },
];

const webSdkExample = `// Sau khi đã load <script src="/api/sdk/web">

const { open, exit, checkStatus } = HARU88Checkout.useHARU88({
  BASE_URL:   "https://your-domain.com/api",
  CLIENT_ID:  "haru88-xxxxxxxxxxxxx",
  API_KEY:    "your-api-key",
  ELEMENT_ID: "payment-container",  // id của div sẽ hiển thị giao diện
  RETURN_URL: "https://your-site.com/return",
  CANCEL_URL: "https://your-site.com/cancel",
  embedded:   true,  // true = nhúng vào trang, false = popup

  onSuccess: (event) => {
    console.log("✅ Thanh toán thành công!", event.orderCode, event.status);
    // event.id — paymentLinkId
    // event.orderCode — mã đơn hàng
    // event.status — "PAID"
    // SDK tự redirect về RETURN_URL sau 1.5s
  },
  onCancel: (event) => {
    console.log("❌ Đơn đã hủy:", event.orderCode);
  },
  onExit: (event) => {
    console.log("Người dùng đóng widget:", event.orderCode);
  },
});

// Mở giao diện thanh toán cho đơn hàng mới
document.getElementById("pay-btn").addEventListener("click", async () => {
  await open({
    orderCode:       803347,
    amount:          50000,
    description:     "THANHTOAN803347",
    expireInMinutes: 15,
  });
});

// Đóng thủ công
document.getElementById("cancel-btn").addEventListener("click", () => exit());`;

const webSdkConfig = [
  { field: "BASE_URL",    type: "string",   required: true,  desc: "URL API server HARU88 của bạn (e.g. https://your-domain.com/api)" },
  { field: "CLIENT_ID",  type: "string",   required: true,  desc: "Client ID từ trang Cài đặt HARU88" },
  { field: "API_KEY",    type: "string",   required: true,  desc: "API Key từ trang Cài đặt HARU88" },
  { field: "ELEMENT_ID", type: "string",   required: true,  desc: "ID của div sẽ chứa giao diện thanh toán" },
  { field: "RETURN_URL", type: "string",   required: true,  desc: "URL redirect sau khi thanh toán thành công" },
  { field: "CANCEL_URL", type: "string",   required: true,  desc: "URL redirect khi hủy đơn" },
  { field: "embedded",   type: "boolean",  required: false, desc: "true = nhúng vào trang, false = popup (mặc định: true)" },
  { field: "onSuccess",  type: "function", required: false, desc: "Callback sau khi thanh toán thành công" },
  { field: "onCancel",   type: "function", required: false, desc: "Callback sau khi hủy đơn" },
  { field: "onExit",     type: "function", required: false, desc: "Callback khi đóng widget" },
];

const endpoints = [
  { method: "GET", path: "/status", description: "Kiểm tra trạng thái server & session", body: null, reqExample: null, resExample: `{\n  "status": "ok",\n  "loggedIn": true,\n  "username": "0912345678"\n}` },
  { method: "POST", path: "/login", description: "Đăng nhập (tự động giải captcha bằng AI OCR)", body: [{ field: "username", type: "string", required: true, desc: "Số điện thoại" }, { field: "password", type: "string", required: true, desc: "Mật khẩu (server tự hash MD5)" }], reqExample: `{\n  "username": "0912345678",\n  "password": "your_password"\n}`, resExample: `{\n  "success": true,\n  "message": "Login successful",\n  "attempts": 1\n}` },
  { method: "POST", path: "/balance", description: "Lấy số dư tất cả tài khoản", body: null, reqExample: `{}`, resExample: `{\n  "success": true,\n  "data": {\n    "totalBalance": 15000000,\n    "accounts": [\n      { "number": "0912345678", "balance": 15000000 }\n    ]\n  }\n}` },
  { method: "POST", path: "/transactions", description: "Lịch sử giao dịch theo khoảng thời gian", body: [{ field: "accountNumber", type: "string", required: true, desc: "Số tài khoản" }, { field: "fromDate", type: "string", required: true, desc: "Từ ngày (DD/MM/YYYY)" }, { field: "toDate", type: "string", required: true, desc: "Đến ngày (DD/MM/YYYY)" }], reqExample: `{\n  "accountNumber": "0912345678",\n  "fromDate": "01/03/2026",\n  "toDate": "27/03/2026"\n}`, resExample: `{\n  "success": true,\n  "data": [\n    {\n      "creditAmount": 500000,\n      "description": "Chuyen tien",\n      "refNo": "FT26086..."\n    }\n  ]\n}` },
  { method: "POST", path: "/encrypt", description: "Generate dataEnc từ JSON payload", body: [{ field: "payload", type: "object", required: true, desc: "JSON cần mã hóa" }, { field: "sessionId", type: "string", required: false, desc: 'Session ID (mặc định "0")' }], reqExample: `{\n  "payload": {"userId": "test"},\n  "sessionId": "0"\n}`, resExample: `{\n  "success": true,\n  "dataEnc": "eyJhbGci..."\n}` },
  { method: "GET", path: "/credentials", description: "Lấy Client ID, API Key, Checksum Key", body: null, reqExample: null, resExample: `{\n  "success": true,\n  "data": {\n    "clientId": "haru88-...",\n    "apiKey": "bc19d6...",\n    "checksumKey": "e851c3..."\n  }\n}` },
];
</script>

<style scoped>
.api-docs { width: 100%; }
.page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.page-header h1 { font-size: 28px; font-weight: 700; }
.page-desc { color: var(--text-secondary); font-size: 14px; margin-bottom: 24px; }

.doc-tabs :deep(.el-tabs__header) { margin-bottom: 24px; }
.doc-tabs :deep(.el-tabs__item) { font-size: 14px; font-weight: 500; }

.doc-section, .endpoint-card { margin-bottom: 24px; }
.section-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
.step-badge { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--el-color-primary); color: white; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.step-desc { color: var(--text-secondary); font-size: 14px; margin: 0 0 16px; line-height: 1.6; }
.sub-heading { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 8px; }
.mb-16 { margin-bottom: 16px; }

/* Credentials overview */
.cred-overview { display: flex; flex-direction: column; gap: 12px; }
.cred-item { display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: rgba(255,255,255,0.03); border-radius: 8px; border: 1px solid var(--border-color); }
.cred-ov-label { font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; min-width: 110px; }
.cred-ov-val { display: flex; align-items: center; gap: 8px; flex: 1; }
.cred-ov-val code { font-family: 'Courier New', monospace; font-size: 13px; color: var(--text-primary); word-break: break-all; }

/* Auth headers table */
.mono { font-family: 'Courier New', monospace; font-size: 12px; }
.mono.accent { color: var(--accent); }

/* Endpoint */
.endpoint-header { display: flex; align-items: center; justify-content: space-between; width: 100%; flex-wrap: wrap; gap: 12px; }
.endpoint-title { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.method-tag { font-family: 'Courier New', monospace; font-weight: 700; min-width: 50px; text-align: center; }
.endpoint-path { font-family: 'Courier New', monospace; font-size: 16px; font-weight: 600; color: var(--accent); }
.endpoint-desc { color: var(--text-secondary); font-size: 13px; }
.endpoint-body { display: flex; flex-direction: column; gap: 20px; margin-top: 10px; }

/* Playground */
.playground-wrapper { margin-bottom: 16px; }
.playground { border: 1px solid var(--accent); border-radius: var(--radius-md); background: rgba(64, 158, 255, 0.04); overflow: hidden; }
.pg-header { padding: 12px 16px; background: rgba(64, 158, 255, 0.1); border-bottom: 1px solid rgba(64, 158, 255, 0.2); font-size: 14px; font-weight: 600; color: var(--accent); display: flex; align-items: center; gap: 8px; }
.pg-body { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.pg-label { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
.mono-textarea :deep(.el-textarea__inner) { font-family: 'Courier New', monospace; font-size: 13px; }
.send-btn { width: 100%; }
.response-label { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.response-meta { display: flex; align-items: center; gap: 12px; }
.response-time { font-size: 12px; color: var(--text-muted); }
.response-block { max-height: 400px; overflow-y: auto; }

.param-section h4, .example-block h4 { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }

/* Code blocks */
.code-block { background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; }
.code-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid var(--border-color); font-size: 12px; color: var(--text-muted); font-weight: 500; }
.code-block pre { margin: 0; padding: 14px 16px; overflow-x: auto; max-height: 500px; overflow-y: auto; }
.code-block code { font-family: 'Courier New', monospace; font-size: 12.5px; line-height: 1.6; color: var(--text-primary); white-space: pre; }
.example-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

.lang-tabs :deep(.el-tabs__header) { margin-bottom: 12px; }

/* Payment flow steps */
.flow-steps { display: flex; flex-direction: column; gap: 4px; }
.flow-step { display: flex; align-items: flex-start; gap: 14px; padding: 12px 14px; background: rgba(255,255,255,0.02); border: 1px solid var(--border-color); border-radius: 8px; }
.flow-arrow { text-align: center; font-size: 18px; color: var(--accent); padding: 2px 0; }
.step-num { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 50%; background: var(--el-color-primary); color: white; font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
.step-sub { font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-top: 3px; display: block; }

/* Payment endpoint list */
.pr-endpoint { margin-bottom: 16px; }
.pr-ep-header { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .endpoint-header { flex-direction: column; align-items: flex-start; }
  .example-grid { grid-template-columns: 1fr; }
  .cred-item { flex-direction: column; align-items: flex-start; }
  .pr-ep-header { flex-direction: column; align-items: flex-start; }
}
</style>
