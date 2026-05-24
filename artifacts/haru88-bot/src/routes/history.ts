import { Router } from "express";
import { storage } from "../lib/storage";

const router = Router();

const diceEmoji: Record<number, string> = { 1: "⚀", 2: "⚁", 3: "⚂", 4: "⚃", 5: "⚄", 6: "⚅" };

function sessionHtml(sessions: Awaited<ReturnType<typeof storage.getTaixiuSessions>>) {
  const latest = sessions.slice(0, 12);

  const rows = latest.map((s, i) => {
    const tai = s.isTai;
    const even = s.isEven;
    const labelTX = tai ? "TÀI" : "XỈU";
    const labelCL = even ? "CHẴN" : "LẺ";
    const txColor = tai ? "#3b9eff" : "#ff5252";
    const clColor = even ? "#4cff80" : "#ffa726";
    const d1 = diceEmoji[s.dice1] ?? String(s.dice1);
    const d2 = diceEmoji[s.dice2] ?? String(s.dice2);
    const d3 = diceEmoji[s.dice3] ?? String(s.dice3);
    const rowClass = i % 2 === 0 ? "row-even" : "row-odd";
    return `<tr class="${rowClass}">
  <td class="td-phien">${s.sessionId}</td>
  <td class="td-kq">
    <span class="badge-tx" style="color:${txColor};border-color:${txColor}40;background:${txColor}15">${labelTX}</span>
    <span class="badge-cl" style="color:${clColor};border-color:${clColor}40;background:${clColor}15">${labelCL}</span>
    <span class="total-num">${s.total}</span>
  </td>
  <td class="td-dice">${d1} <span class="dv">${s.dice1}</span></td>
  <td class="td-dice">${d2} <span class="dv">${s.dice2}</span></td>
  <td class="td-dice">${d3} <span class="dv">${s.dice3}</span></td>
</tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<title>Lịch Sử Phiên · HARU88</title>
<link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;700;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:'Be Vietnam Pro',sans-serif;
  background:radial-gradient(ellipse at 20% 10%,rgba(180,130,0,0.18) 0%,transparent 50%),
             radial-gradient(ellipse at 80% 90%,rgba(120,80,0,0.15) 0%,transparent 50%),
             linear-gradient(160deg,#0a0800 0%,#130e00 50%,#0a0800 100%);
  min-height:100vh;color:#e8d5a0;
}

/* ── HERO HEADER ── */
.hero{
  text-align:center;
  padding:28px 20px 20px;
  position:relative;
  border-bottom:1px solid rgba(255,215,0,0.18);
  background:linear-gradient(180deg,rgba(255,215,0,0.07) 0%,transparent 100%);
}
.hero::before{
  content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 0%,rgba(255,215,0,0.12) 0%,transparent 65%);
  pointer-events:none;
}
.slogan{
  font-size:12px;font-weight:700;letter-spacing:4px;text-transform:uppercase;
  color:rgba(255,215,0,0.55);margin-bottom:6px;
}
.brand{
  font-size:30px;font-weight:900;letter-spacing:6px;
  background:linear-gradient(135deg,#B8860B,#FFD700,#FFA500,#FFD700);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  text-shadow:none;
  margin-bottom:4px;
}
.page-title{
  font-size:15px;font-weight:700;color:rgba(255,215,0,0.7);letter-spacing:2px;
}

/* ── TOOLBAR ── */
.toolbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 20px;
  border-bottom:1px solid rgba(255,215,0,0.1);
  background:rgba(0,0,0,0.25);
}
.info-pill{
  font-size:11px;color:rgba(255,215,0,0.45);letter-spacing:1px;
}
.refresh-btn{
  display:inline-flex;align-items:center;gap:5px;
  background:rgba(255,215,0,0.08);border:1px solid rgba(255,215,0,0.25);
  color:rgba(255,215,0,0.65);font-size:11px;font-weight:700;letter-spacing:1px;
  padding:5px 14px;border-radius:20px;text-decoration:none;transition:.15s;
}
.refresh-btn:hover{background:rgba(255,215,0,0.18);color:#FFD700;border-color:rgba(255,215,0,0.5);}

/* ── TABLE ── */
.tbl-wrap{overflow-x:auto;padding:20px 16px;-webkit-overflow-scrolling:touch;}
table{
  width:100%;border-collapse:collapse;
  background:rgba(0,0,0,0.3);
  border:1px solid rgba(255,215,0,0.15);
  border-radius:14px;overflow:hidden;
}
thead tr{
  background:linear-gradient(90deg,rgba(180,134,11,0.35),rgba(255,215,0,0.2),rgba(180,134,11,0.35));
  border-bottom:2px solid rgba(255,215,0,0.35);
}
th{
  padding:13px 16px;text-align:center;
  font-size:11px;font-weight:900;letter-spacing:2px;text-transform:uppercase;
  color:#FFD700;
}
th:first-child{text-align:left;}
.row-even{background:rgba(255,255,255,0.025);}
.row-odd{background:rgba(0,0,0,0.15);}
tr:hover td{background:rgba(255,215,0,0.05);}
td{padding:12px 16px;border-bottom:1px solid rgba(255,215,0,0.07);vertical-align:middle;text-align:center;}
td:first-child{text-align:left;}
tr:last-child td{border-bottom:none;}

.td-phien{font-size:14px;font-weight:900;color:#FFD700;}
.td-kq{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:160px;}
.badge-tx,.badge-cl{
  font-size:10px;font-weight:900;letter-spacing:1px;
  padding:2px 9px;border-radius:20px;border:1px solid;white-space:nowrap;
}
.total-num{font-size:20px;font-weight:900;color:#FFD700;margin-left:4px;}
.td-dice{font-size:20px;white-space:nowrap;}
.dv{font-size:11px;font-weight:700;color:rgba(255,215,0,0.4);margin-left:2px;vertical-align:middle;}

/* ── EMPTY ── */
.empty{text-align:center;padding:60px 20px;color:rgba(255,215,0,0.3);font-size:14px;letter-spacing:1px;}

/* ── FOOTER ── */
.footer{text-align:center;padding:16px;font-size:10px;color:rgba(255,215,0,0.2);letter-spacing:2px;}

@media(max-width:520px){
  .brand{font-size:22px;letter-spacing:3px;}
  th,td{padding:9px 10px;font-size:10px;}
  .total-num{font-size:16px;}
  .td-dice{font-size:16px;}
}
</style>
</head>
<body>
<div class="hero">
  <div class="slogan">Thiên đường giải trí</div>
  <div class="brand">HARU88</div>
  <div class="page-title">✦ Lịch Sử Phiên ✦</div>
</div>
<div class="toolbar">
  <span class="info-pill">📌 Hiển thị 12 phiên gần nhất · phiên mới vào → phiên cũ tự xoá</span>
  <a class="refresh-btn" href="/api/history">↺ LÀM MỚI</a>
</div>
<div class="tbl-wrap">
${latest.length === 0
    ? '<div class="empty">⏳ Chưa có phiên nào được ghi lại</div>'
    : `<table>
  <thead>
    <tr>
      <th>Phiên</th>
      <th>KQ</th>
      <th>XX1</th>
      <th>XX2</th>
      <th>XX3</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`}
</div>
<div class="footer">HARU88 · GAME · ${new Date().getFullYear()}</div>
<script>
(function(){const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();}})();
let _cd=30;
function _tick(){
  _cd--;
  if(_cd<=0){location.reload();return;}
  setTimeout(_tick,1000);
}
setTimeout(_tick,1000);
</script>
</body>
</html>`;
}

function md5Html(sessions: Awaited<ReturnType<typeof storage.getTaixiuSessions>>) {
  const rows = sessions.map((s, i) => {
    const rowClass = i % 2 === 0 ? "row-even" : "row-odd";
    return `<tr class="${rowClass}">
  <td class="td-code" onclick="copyCell(this)" title="Nhấn để sao chép">${s.md5Original}</td>
  <td class="td-hash" onclick="copyCell(this)" title="Nhấn để sao chép">${s.md5Hash}</td>
</tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lịch Sử MD5 · HARU88</title>
<link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;700;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:'Be Vietnam Pro',sans-serif;
  background:radial-gradient(ellipse at 20% 10%,rgba(180,130,0,0.18) 0%,transparent 50%),
             radial-gradient(ellipse at 80% 90%,rgba(120,80,0,0.15) 0%,transparent 50%),
             linear-gradient(160deg,#0a0800 0%,#130e00 50%,#0a0800 100%);
  min-height:100vh;color:#e8d5a0;
}

/* ── HERO HEADER ── */
.hero{
  text-align:center;
  padding:28px 20px 20px;
  position:relative;
  border-bottom:1px solid rgba(255,215,0,0.18);
  background:linear-gradient(180deg,rgba(255,215,0,0.07) 0%,transparent 100%);
}
.hero::before{
  content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 0%,rgba(255,215,0,0.12) 0%,transparent 65%);
  pointer-events:none;
}
.slogan{
  font-size:12px;font-weight:700;letter-spacing:4px;text-transform:uppercase;
  color:rgba(255,215,0,0.55);margin-bottom:6px;
}
.brand{
  font-size:30px;font-weight:900;letter-spacing:6px;
  background:linear-gradient(135deg,#B8860B,#FFD700,#FFA500,#FFD700);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
  margin-bottom:4px;
}
.page-title{
  font-size:15px;font-weight:700;color:rgba(255,215,0,0.7);letter-spacing:2px;
}

/* ── TOOLBAR ── */
.toolbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 20px;
  border-bottom:1px solid rgba(255,215,0,0.1);
  background:rgba(0,0,0,0.25);
}
.info-pill{font-size:11px;color:rgba(255,215,0,0.45);letter-spacing:1px;}
.refresh-btn{
  display:inline-flex;align-items:center;gap:5px;
  background:rgba(255,215,0,0.08);border:1px solid rgba(255,215,0,0.25);
  color:rgba(255,215,0,0.65);font-size:11px;font-weight:700;letter-spacing:1px;
  padding:5px 14px;border-radius:20px;text-decoration:none;transition:.15s;
}
.refresh-btn:hover{background:rgba(255,215,0,0.18);color:#FFD700;border-color:rgba(255,215,0,0.5);}

/* ── VERIFY TIP ── */
.verify-tip{
  margin:14px 16px 0;
  background:rgba(255,215,0,0.05);
  border:1px solid rgba(255,215,0,0.15);
  border-radius:10px;
  padding:10px 16px;
  font-size:11px;color:rgba(255,215,0,0.45);line-height:1.7;letter-spacing:.3px;
}
.verify-tip strong{color:rgba(255,215,0,0.7);}

/* ── TABLE ── */
.tbl-wrap{overflow-x:auto;padding:14px 16px 20px;-webkit-overflow-scrolling:touch;}
table{
  width:100%;border-collapse:collapse;
  background:rgba(0,0,0,0.3);
  border:1px solid rgba(255,215,0,0.15);
  border-radius:14px;overflow:hidden;
}
thead tr{
  background:linear-gradient(90deg,rgba(180,134,11,0.35),rgba(255,215,0,0.2),rgba(180,134,11,0.35));
  border-bottom:2px solid rgba(255,215,0,0.35);
}
th{
  padding:13px 18px;text-align:left;
  font-size:11px;font-weight:900;letter-spacing:2px;text-transform:uppercase;
  color:#FFD700;
}
.row-even{background:rgba(255,255,255,0.025);}
.row-odd{background:rgba(0,0,0,0.15);}
tr:hover td{background:rgba(255,215,0,0.05);cursor:pointer;}
td{
  padding:11px 18px;
  border-bottom:1px solid rgba(255,215,0,0.07);
  vertical-align:middle;
  word-break:break-all;
}
tr:last-child td{border-bottom:none;}

.td-code{
  font-family:'Courier New',monospace;font-size:12px;
  color:#FFD700;font-weight:600;
  max-width:260px;
}
.td-hash{
  font-family:'Courier New',monospace;font-size:11px;
  color:rgba(255,215,0,0.4);
}
tr:hover .td-code{color:#ffe55c;}
tr:hover .td-hash{color:rgba(255,215,0,0.65);}

/* ── COPY INDICATOR ── */
.copy-hint{font-size:9px;color:rgba(255,215,0,0.25);margin-left:6px;letter-spacing:1px;}

/* ── EMPTY ── */
.empty{text-align:center;padding:60px 20px;color:rgba(255,215,0,0.3);font-size:14px;letter-spacing:1px;}

/* ── TOAST ── */
.toast{
  position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(10px);
  background:linear-gradient(135deg,#B8860B,#FFD700);
  color:#000;font-weight:800;font-size:13px;letter-spacing:1px;
  padding:9px 22px;border-radius:30px;
  opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;
  box-shadow:0 4px 20px rgba(255,215,0,0.35);
}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0);}

/* ── FOOTER ── */
.footer{text-align:center;padding:16px;font-size:10px;color:rgba(255,215,0,0.2);letter-spacing:2px;}

@media(max-width:520px){
  .brand{font-size:22px;letter-spacing:3px;}
  th,td{padding:9px 10px;font-size:10px;}
  .td-code{font-size:10px;}
  .td-hash{font-size:9px;}
}
</style>
</head>
<body>
<div class="hero">
  <div class="slogan">Thiên đường giải trí</div>
  <div class="brand">HARU88</div>
  <div class="page-title">✦ Lịch Sử MD5 ✦</div>
</div>
<div class="toolbar">
  <span class="info-pill">🔐 ${sessions.length} phiên · Nhấn ô để sao chép</span>
  <a class="refresh-btn" href="/api/history/md5">↺ LÀM MỚI</a>
</div>
<div class="verify-tip">
  <strong>Cách xác minh:</strong> Lấy <em>Mã kết quả</em> → chạy hàm MD5 → so sánh với <em>Mã hoá</em>. Kết quả khớp = kết quả minh bạch, không can thiệp.
</div>
<div class="tbl-wrap">
${sessions.length === 0
    ? '<div class="empty">⏳ Chưa có phiên nào được ghi lại</div>'
    : `<table>
  <thead>
    <tr>
      <th>Mã kết quả <span class="copy-hint">NHẤN ĐỂ SAO CHÉP</span></th>
      <th>Mã hoá</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`}
</div>
<div class="toast" id="toast">✓ Đã sao chép!</div>
<div class="footer">HARU88 · GAME · ${new Date().getFullYear()}</div>
<script>
(function(){const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();}})();
let _cdMd5=30;
function _tickMd5(){_cdMd5--;if(_cdMd5<=0){location.reload();return;}setTimeout(_tickMd5,1000);}
setTimeout(_tickMd5,1000);
let _toastTimer;
function copyCell(el){
  const t=(el.innerText||el.textContent||'').trim();
  if(!t){return;}
  function showOk(){
    const d=document.getElementById('toast');
    d.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer=setTimeout(()=>d.classList.remove('show'),1600);
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(showOk).catch(()=>fallback(el,t,showOk));
  } else {
    fallback(el,t,showOk);
  }
}
function fallback(el,t,cb){
  try{
    const ta=document.createElement('textarea');
    ta.value=t;ta.style.cssText='position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);ta.focus();ta.select();
    if(document.execCommand('copy')){cb();}
    else{
      const r=document.createRange();r.selectNodeContents(el);
      const sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
    }
    document.body.removeChild(ta);
  }catch(e){
    const r=document.createRange();r.selectNodeContents(el);
    const sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
  }
}
</script>
</body>
</html>`;
}

router.get("/history", async (req, res) => {
  try {
    const sessions = await storage.getTaixiuSessions(12);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(sessionHtml(sessions));
  } catch (err) {
    res.status(500).send("Lỗi server");
  }
});

router.get("/history/md5", async (req, res) => {
  try {
    const sessions = await storage.getTaixiuSessions(100);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(md5Html(sessions));
  } catch (err) {
    res.status(500).send("Lỗi server");
  }
});

export default router;
