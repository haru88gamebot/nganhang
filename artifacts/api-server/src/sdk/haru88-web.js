/**
 * HARU88 Web Checkout SDK
 * Script nhúng thanh toán vào trang web của bạn.
 *
 * Cách dùng:
 *   <script src="https://your-haru88-domain.com/api/sdk/web"></script>
 *
 * Sau đó:
 *   const { open, exit } = HARU88Checkout.useHARU88({
 *     BASE_URL: "https://your-haru88-domain.com/api",
 *     CLIENT_ID: "haru88-xxx",
 *     API_KEY: "your-api-key",
 *     ELEMENT_ID: "payment-container",
 *     RETURN_URL: "https://your-site.com/return",
 *     CANCEL_URL: "https://your-site.com/cancel",
 *     onSuccess: (event) => { ... },
 *     onCancel: (event) => { ... },
 *   });
 *   open({ orderCode: 123, amount: 50000, description: "THANHTOAN123" });
 */

(function (global) {
  "use strict";

  const HARU88Checkout = {
    /**
     * Khởi tạo checkout widget.
     * @param {Object} config - Cấu hình
     * @returns {{ open, exit, checkStatus }}
     */
    useHARU88(config) {
      const {
        BASE_URL,
        CLIENT_ID,
        API_KEY,
        ELEMENT_ID,
        RETURN_URL,
        CANCEL_URL,
        onSuccess,
        onCancel,
        onExit,
        embedded = true,
      } = config;

      if (!BASE_URL || !CLIENT_ID || !API_KEY) {
        throw new Error("[HARU88] BASE_URL, CLIENT_ID và API_KEY là bắt buộc");
      }

      let pollTimer = null;
      let currentOrderCode = null;
      let containerEl = null;

      // ── Create payment request via HARU88 API ────────────────────────────
      async function createPaymentRequest(orderCode, amount, description, expireInMinutes = 15) {
        const res = await fetch(`${BASE_URL}/payment-requests`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Client-ID": CLIENT_ID,
            "X-API-Key": API_KEY,
          },
          body: JSON.stringify({
            orderCode,
            amount,
            description,
            returnUrl: RETURN_URL + (RETURN_URL.includes("?") ? "&" : "?") + `orderCode=${orderCode}`,
            cancelUrl: CANCEL_URL + (CANCEL_URL.includes("?") ? "&" : "?") + `orderCode=${orderCode}`,
            expireInMinutes,
          }),
        });
        const data = await res.json();
        if (data.code !== "00") throw new Error(data.desc);
        return data.data;
      }

      // ── Poll for payment status ──────────────────────────────────────────
      async function pollStatus(orderCode, intervalMs = 5000) {
        const res = await fetch(`${BASE_URL}/payment-requests/${orderCode}`, {
          headers: { "X-Client-ID": CLIENT_ID, "X-API-Key": API_KEY },
        });
        const json = await res.json();
        return json.data;
      }

      // ── Render payment info UI ───────────────────────────────────────────
      function renderPaymentUI(el, pr) {
        const fmt = (n) => n.toLocaleString("vi-VN") + " ₫";
        el.innerHTML = `
          <div style="font-family:sans-serif;padding:24px;background:#0d1117;color:#e6edf3;border-radius:12px;max-width:420px;margin:0 auto;border:1px solid #30363d;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
              <span style="font-size:22px;">💳</span>
              <span style="font-size:18px;font-weight:700;background:linear-gradient(135deg,#00d2ff,#3a7bd5);-webkit-background-clip:text;-webkit-text-fill-color:transparent;">HARU88 Payment</span>
            </div>
            <div style="background:#161b22;border-radius:8px;padding:16px;margin-bottom:16px;border:1px solid #30363d;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="color:#8b949e;font-size:13px;">Số tiền</span>
                <span style="font-size:22px;font-weight:700;color:#3fb950;">${fmt(pr.amount)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="color:#8b949e;font-size:13px;">Nội dung CK</span>
                <code style="background:#0d1117;padding:3px 8px;border-radius:4px;font-size:13px;color:#79c0ff;border:1px solid #30363d;">${pr.description}</code>
              </div>
              <div style="display:flex;justify-content:space-between;">
                <span style="color:#8b949e;font-size:13px;">Mã đơn hàng</span>
                <span style="font-size:13px;color:#e6edf3;">#${pr.orderCode}</span>
              </div>
            </div>
            <div id="haru88-status-area" style="text-align:center;padding:12px;background:#161b22;border-radius:8px;border:1px solid #30363d;">
              <div style="color:#8b949e;font-size:13px;">⏳ Đang chờ thanh toán...</div>
              <div style="color:#6e7681;font-size:11px;margin-top:4px;">Tự động phát hiện sau khi chuyển khoản</div>
            </div>
            <div style="display:flex;gap:8px;margin-top:16px;">
              <button id="haru88-cancel-btn" style="flex:1;padding:10px;background:transparent;border:1px solid #30363d;border-radius:6px;color:#8b949e;cursor:pointer;font-size:13px;">Hủy đơn</button>
            </div>
            <div style="text-align:center;margin-top:12px;font-size:11px;color:#484f58;">Powered by HARU88 Panel</div>
          </div>
        `;

        document.getElementById("haru88-cancel-btn")?.addEventListener("click", () => {
          exit();
          if (typeof onCancel === "function") onCancel({ orderCode: pr.orderCode, status: "CANCELLED" });
        });
      }

      // ── Start polling ────────────────────────────────────────────────────
      function startPolling(orderCode) {
        currentOrderCode = orderCode;
        pollTimer = setInterval(async () => {
          try {
            const pr = await pollStatus(orderCode);
            if (pr.status === "PAID") {
              clearInterval(pollTimer);
              const statusArea = document.getElementById("haru88-status-area");
              if (statusArea) {
                statusArea.innerHTML = `<div style="color:#3fb950;font-size:15px;font-weight:700;">✅ Thanh toán thành công!</div>`;
              }
              setTimeout(() => {
                exit();
                if (typeof onSuccess === "function") onSuccess({ orderCode, status: "PAID", id: pr.id, code: "00" });
                const url = `${RETURN_URL}${RETURN_URL.includes("?") ? "&" : "?"}orderCode=${orderCode}&status=PAID&id=${pr.id}&code=00`;
                window.location.href = url;
              }, 1500);
            } else if (pr.status === "CANCELLED") {
              clearInterval(pollTimer);
              exit();
              if (typeof onCancel === "function") onCancel({ orderCode, status: "CANCELLED" });
            }
          } catch (e) {
            console.warn("[HARU88] Poll error:", e.message);
          }
        }, 5000);
      }

      // ── Public API ────────────────────────────────────────────────────────
      return {
        /**
         * Mở giao diện thanh toán.
         * @param {{ orderCode, amount, description, expireInMinutes? }} paymentData
         */
        async open(paymentData) {
          const { orderCode, amount, description, expireInMinutes } = paymentData;
          try {
            const pr = await createPaymentRequest(orderCode, amount, description, expireInMinutes);
            if (embedded && ELEMENT_ID) {
              containerEl = document.getElementById(ELEMENT_ID);
              if (!containerEl) throw new Error(`#${ELEMENT_ID} không tồn tại`);
              renderPaymentUI(containerEl, pr);
            }
            startPolling(orderCode);
            return pr;
          } catch (err) {
            console.error("[HARU88] open() error:", err.message);
            throw err;
          }
        },

        /** Đóng giao diện thanh toán và dừng polling. */
        exit() {
          if (pollTimer) clearInterval(pollTimer);
          if (containerEl) containerEl.innerHTML = "";
          if (typeof onExit === "function") onExit({ orderCode: currentOrderCode });
          currentOrderCode = null;
          containerEl = null;
        },

        /** Kiểm tra trạng thái thủ công. */
        async checkStatus(orderCode) {
          return pollStatus(orderCode);
        },
      };
    },
  };

  // Expose globally
  global.HARU88Checkout = HARU88Checkout;
})(typeof window !== "undefined" ? window : globalThis);
