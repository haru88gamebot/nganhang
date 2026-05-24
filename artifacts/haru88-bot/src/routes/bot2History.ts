import { Router, type Request, type Response } from "express";
import { storage } from "../lib/storage";

const router = Router();

/* ─── Shared page shell ──────────────────────────────────── */
function pageShell(title: string, body: string, extraScript = ""): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<script>if(!window.Telegram){window.Telegram={WebApp:{initData:'',initDataUnsafe:{},ready:function(){},expand:function(){},close:function(){},showAlert:function(m,cb){alert(m);if(cb)cb();},showConfirm:function(m,cb){if(cb)cb(confirm(m));},MainButton:{setText:function(){},show:function(){},hide:function(){}},BackButton:{show:function(){},hide:function(){},onClick:function(){}},themeParams:{},colorScheme:'dark',viewportHeight:window.innerHeight,viewportStableHeight:window.innerHeight,isExpanded:true,platform:'browser',version:'6.0'}};}</script>
<title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060910;color:#e5e7eb;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;padding-bottom:20px}
.header{background:linear-gradient(135deg,#1a1a3e,#0f0f2e);padding:14px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1f2937;position:sticky;top:0;z-index:10}
.header h1{font-size:16px;font-weight:700;color:#f0c040;flex:1}
.refresh-btn{background:#1f2937;border:1px solid #374151;color:#9ca3af;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;transition:.15s;white-space:nowrap}
.refresh-btn:active{background:#374151}
.auto-label{font-size:10px;color:#4b5563;text-align:right;padding:3px 12px 0}
.stats-row{display:flex;gap:8px;padding:10px 12px;background:#0d1117;border-bottom:1px solid #1f2937}
.stat-box{flex:1;background:#111827;border:1px solid #1f2937;border-radius:10px;padding:8px 10px;text-align:center}
.stat-box .sv{font-size:18px;font-weight:700;color:#10b981}
.stat-box .sk{font-size:10px;color:#6b7280;margin-top:1px}
.container{padding:10px 12px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#111827;color:#6b7280;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 6px;text-align:left;border-bottom:1px solid #1f2937;white-space:nowrap}
td{padding:8px 6px;border-bottom:1px solid #1a1f2e;vertical-align:middle}
tr:hover td{background:#0d1117}
.round-id{color:#6b7280;font-size:12px}
.dice-row{display:flex;gap:3px;align-items:center}
.dice-cell{background:#1f2937;border-radius:5px;padding:2px 5px;font-size:12px;font-weight:700}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap}
.tai{background:#1d3a5c;color:#60a5fa}
.xiu{background:#3d1d1d;color:#f87171}
.chan{background:#1d2e1d;color:#86efac}
.le{background:#2d2820;color:#fbbf24}
.total-num{font-size:15px;font-weight:700}
.md5-code{font-family:monospace;font-size:11px;color:#818cf8;word-break:break-all;line-height:1.5}
.hash-code{font-family:monospace;font-size:10px;color:#6b7280;word-break:break-all;margin-top:3px}
.btn-row{display:flex;gap:6px;margin-top:5px;flex-wrap:wrap}
.copy-btn{background:none;border:1px solid #374151;color:#9ca3af;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer;transition:.15s;white-space:nowrap}
.copy-btn:active,.copy-btn.copied{background:#059669;border-color:#059669;color:#fff}
.verify-btn{background:none;border:1px solid #374151;color:#818cf8;border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer;transition:.15s;white-space:nowrap;text-decoration:none;display:inline-block}
.verify-btn:active{background:#1e1b4b;border-color:#818cf8}
.empty{text-align:center;padding:40px 16px;color:#374151;font-size:14px}
.empty-icon{font-size:36px;margin-bottom:8px}
.tai-xiu-bar{display:flex;gap:4px;padding:10px 12px;overflow-x:auto;scrollbar-width:none}
.tai-xiu-bar::-webkit-scrollbar{display:none}
.chip{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;cursor:default}
.chip-tai{background:#1d3a5c;color:#60a5fa;border:1px solid #2d5a8c}
.chip-xiu{background:#3d1d1d;color:#f87171;border:1px solid #6b2d2d}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#059669;color:#fff;padding:9px 18px;border-radius:20px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999;white-space:nowrap;max-width:90vw}
.toast.show{opacity:1}
.hint{font-size:10px;color:#4b5563;margin-top:2px}
.countdown-bar{height:2px;background:#111827;position:sticky;top:49px;z-index:9}
.countdown-fill{height:100%;background:#10b981;transition:width 1s linear;width:100%}
</style>
</head>
<body>
${body}
<div class="toast" id="toast"></div>
<script>
/* ── Telegram WebApp init ── */
(function(){
  const tg=window.Telegram?.WebApp;
  if(tg){ tg.ready(); tg.expand(); }
})();

/* ── Toast ── */
let _tt;
function showToast(msg,color){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.background=color||'#059669';
  t.classList.add('show');
  clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),2000);
}

/* ── Copy helpers ── */
function copyText(txt,btn){
  const clean=(txt||'').trim();
  if(!clean||clean==='-'){showToast('Không có dữ liệu!','#dc2626');return;}
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(clean).then(()=>onCopied(btn)).catch(()=>fallbackCopy(clean,btn));
  } else {
    fallbackCopy(clean,btn);
  }
}
function fallbackCopy(txt,btn){
  try{
    const ta=document.createElement('textarea');
    ta.value=txt;
    ta.style.cssText='position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);ta.focus();ta.select();
    const ok=document.execCommand('copy');
    document.body.removeChild(ta);
    if(ok){ onCopied(btn); }
    else { showToast('Nhấn giữ → Chép thủ công','#d97706'); }
  }catch(e){ showToast('Nhấn giữ → Chép thủ công','#d97706'); }
}
function onCopied(btn){
  if(btn){ btn.classList.add('copied'); btn.textContent='✓ Đã chép'; }
  showToast('✅ Đã chép mã gốc!');
  setTimeout(()=>{ if(btn){ btn.classList.remove('copied'); btn.textContent='Chép mã'; } },1800);
}

/* ── Verify: copy + open md5.cz ── */
function verifyMd5(origId,btn){
  const el=document.getElementById(origId);
  if(!el){ showToast('Không tìm thấy dữ liệu!','#dc2626');return; }
  const txt=(el.textContent||'').trim();
  if(!txt||txt==='-'){ showToast('Chưa có mã gốc!','#dc2626');return; }
  copyText(txt,null);
  setTimeout(()=>{ window.open('https://md5.cz','_blank'); },300);
  showToast('✅ Đã chép! Paste vào md5.cz');
}

/* ── Auto-refresh countdown ── */
${extraScript}
</script>
</body>
</html>`;
}

/* ─── Auto-refresh script ────────────────────────────────── */
const AUTO_REFRESH_SCRIPT = `
let _countdown=30;
function tickRefresh(){
  _countdown--;
  const fill=document.getElementById('cdFill');
  if(fill) fill.style.width=(_countdown/30*100)+'%';
  if(_countdown<=0){ location.reload(); return; }
  setTimeout(tickRefresh,1000);
}
setTimeout(tickRefresh,1000);
`;

/* ─── GET /api/bot2/history — Session history HTML ──────── */
router.get("/bot2/history", async (_req: Request, res: Response): Promise<void> => {
  try {
    const sessions = await storage.getTaixiuSessions(50);

    const taiCount = sessions.filter(s => s.isTai).length;
    const xiuCount = sessions.length - taiCount;
    const chanCount = sessions.filter(s => s.isEven).length;
    const leCount = sessions.length - chanCount;

    // chips: newest 30, ordered oldest→newest (left→right)
    const chipsData = [...sessions].reverse().slice(-30);
    const chips = chipsData.map(s => {
      const cls = s.isTai ? "chip-tai" : "chip-xiu";
      const label = s.isTai ? "T" : "X";
      const title = s.isTai ? "TÀI" : "XỈU";
      return `<div class="chip ${cls}" title="${title}">${label}</div>`;
    }).join("");

    const rows = sessions.length === 0
      ? `<tr><td colspan="6" class="empty"><div class="empty-icon">📭</div><div>Chưa có phiên nào<br><small style="color:#4b5563">Dữ liệu sẽ hiện sau khi Bot 2 chạy phiên đầu tiên</small></div></td></tr>`
      : sessions.map(s => {
          const txClass = s.isTai ? "tai" : "xiu";
          const txLabel = s.isTai ? "🔵 TÀI" : "🔴 XỈU";
          const clClass = s.isEven ? "chan" : "le";
          const clLabel = s.isEven ? "⚪️ CHẴN" : "⚫️ LẺ";
          const d1 = Number(s.dice1), d2 = Number(s.dice2), d3 = Number(s.dice3);
          const total = Number(s.total);
          const dEmoji = (n: number) => ["⚀","⚁","⚂","⚃","⚄","⚅"][n-1] ?? String(n);
          const winnings = Number(s.totalWinnings || 0);
          const losings = Number(s.totalLosings || 0);
          const net = winnings - losings;
          const netColor = net > 0 ? "#10b981" : net < 0 ? "#ef4444" : "#6b7280";
          const netSign = net > 0 ? "+" : "";
          return `<tr>
            <td><span class="round-id">#${s.sessionId}</span></td>
            <td><div class="dice-row">
              <span class="dice-cell">${dEmoji(d1)}</span>
              <span class="dice-cell">${dEmoji(d2)}</span>
              <span class="dice-cell">${dEmoji(d3)}</span>
            </div></td>
            <td><span class="total-num">${total}</span></td>
            <td><span class="badge ${txClass}">${txLabel}</span></td>
            <td><span class="badge ${clClass}">${clLabel}</span></td>
            <td style="font-size:11px;white-space:nowrap">
              <span style="color:#10b981">+${winnings.toLocaleString("vi-VN")}</span><br>
              <span style="color:#ef4444">-${losings.toLocaleString("vi-VN")}</span><br>
              <span style="color:${netColor};font-weight:700">${netSign}${net.toLocaleString("vi-VN")}</span>
            </td>
          </tr>`;
        }).join("");

    const body = `
<div class="header">
  <h1>📊 Lịch Sử Phiên Tài Xỉu</h1>
  <button class="refresh-btn" onclick="location.reload()">🔄 Làm mới</button>
</div>
<div class="auto-label">Tự làm mới sau <span id="cdSec">30</span>s</div>
<div class="countdown-bar"><div class="countdown-fill" id="cdFill"></div></div>

<div class="stats-row">
  <div class="stat-box"><div class="sv" style="color:#60a5fa">${taiCount}</div><div class="sk">🔵 TÀI</div></div>
  <div class="stat-box"><div class="sv" style="color:#f87171">${xiuCount}</div><div class="sk">🔴 XỈU</div></div>
  <div class="stat-box"><div class="sv" style="color:#86efac">${chanCount}</div><div class="sk">⚪️ CHẴN</div></div>
  <div class="stat-box"><div class="sv" style="color:#fbbf24">${leCount}</div><div class="sk">⚫️ LẺ</div></div>
</div>

${chips ? `<div class="tai-xiu-bar" title="Cũ → Mới">${chips}</div>` : ""}

<div class="container">
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Phiên</th>
          <th>Xúc xắc</th>
          <th>Tổng</th>
          <th>Tài/Xỉu</th>
          <th>Chẵn/Lẻ</th>
          <th>Thắng/Thua/Net</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;

    const refreshScript = `
let _countdown=30;
function tickRefresh(){
  _countdown--;
  const fill=document.getElementById('cdFill');
  const sec=document.getElementById('cdSec');
  if(fill) fill.style.width=(_countdown/30*100)+'%';
  if(sec) sec.textContent=_countdown;
  if(_countdown<=0){ location.reload(); return; }
  setTimeout(tickRefresh,1000);
}
setTimeout(tickRefresh,1000);
`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(pageShell("📊 Lịch Sử Phiên", body, refreshScript));
  } catch {
    res.status(500).send("Lỗi server");
  }
});

/* ─── GET /api/bot2/md5 — MD5 history HTML ──────────────── */
router.get("/bot2/md5", async (_req: Request, res: Response): Promise<void> => {
  try {
    const sessions = await storage.getTaixiuSessions(50);

    const rows = sessions.length === 0
      ? `<tr><td colspan="3" class="empty"><div class="empty-icon">🔐</div><div>Chưa có dữ liệu MD5 nào<br><small style="color:#4b5563">Dữ liệu sẽ hiện sau khi Bot 2 chạy phiên đầu tiên</small></div></td></tr>`
      : sessions.map(s => {
          const origId = `orig_${s.sessionId}`;
          const orig = (s.md5Original ?? "").trim() || "-";
          const hash = (s.md5Hash ?? "").trim() || "-";
          return `<tr>
            <td style="white-space:nowrap;vertical-align:top;padding-top:10px"><span class="round-id">#${s.sessionId}</span></td>
            <td>
              <div class="md5-code" id="${origId}">${orig}</div>
              <div class="hash-code">→ ${hash}</div>
              <div class="btn-row">
                <button class="copy-btn" onclick="copyText(document.getElementById('${origId}').textContent,this)">Chép mã</button>
                <button class="verify-btn" onclick="verifyMd5('${origId}',this)">🔗 Kiểm tra</button>
              </div>
              <div class="hint">Chép mã → Dán vào md5.cz → Hash → So với dòng trên</div>
            </td>
          </tr>`;
        }).join("");

    const body = `
<div class="header">
  <h1>🔐 Lịch Sử MD5 Tài Xỉu</h1>
  <button class="refresh-btn" onclick="location.reload()">🔄 Làm mới</button>
</div>
<div class="auto-label">Tự làm mới sau <span id="cdSec">30</span>s</div>
<div class="countdown-bar"><div class="countdown-fill" id="cdFill"></div></div>

<div class="stats-row">
  <div class="stat-box"><div class="sv">${sessions.length}</div><div class="sk">Tổng phiên</div></div>
  <div class="stat-box" style="flex:2">
    <div style="font-size:10px;color:#6b7280;margin-bottom:3px">Xác minh tại</div>
    <a href="https://md5.cz" target="_blank" style="color:#818cf8;font-size:13px;font-weight:700;text-decoration:none">🔗 md5.cz</a>
  </div>
</div>

<div class="container">
  <div style="margin-bottom:10px;font-size:12px;color:#6b7280;line-height:1.6;background:#111827;border:1px solid #1f2937;border-radius:10px;padding:12px">
    📌 <b style="color:#9ca3af">Cách xác minh tính minh bạch:</b><br>
    1. Nhấn <b style="color:#818cf8">"Chép mã"</b> để chép mã gốc của phiên cần kiểm tra<br>
    2. Nhấn <b style="color:#818cf8">"Kiểm tra"</b> — mã đã được tự động chép, chỉ cần dán (Ctrl+V / paste) vào md5.cz<br>
    3. Nhấn <b style="color:#9ca3af">Hash</b> trên md5.cz — kết quả phải khớp với hash hiển thị
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Phiên</th>
          <th>Mã gốc → Hash MD5</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</div>`;

    const refreshScript = `
let _countdown=30;
function tickRefresh(){
  _countdown--;
  const fill=document.getElementById('cdFill');
  const sec=document.getElementById('cdSec');
  if(fill) fill.style.width=(_countdown/30*100)+'%';
  if(sec) sec.textContent=_countdown;
  if(_countdown<=0){ location.reload(); return; }
  setTimeout(tickRefresh,1000);
}
setTimeout(tickRefresh,1000);
`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(pageShell("🔐 Lịch Sử MD5", body, refreshScript));
  } catch {
    res.status(500).send("Lỗi server");
  }
});

/* ─── JSON API endpoints ─────────────────────────────────── */
router.get("/bot2/history-data", async (_req: Request, res: Response): Promise<void> => {
  try {
    const sessions = await storage.getTaixiuSessions(50);
    res.json({ ok: true, sessions });
  } catch {
    res.status(500).json({ ok: false });
  }
});

export default router;
