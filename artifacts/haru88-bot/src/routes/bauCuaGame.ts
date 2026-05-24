import { Router, type Request, type Response } from "express";
import { storage } from "../lib/storage";
import { gameServer, registerSSEGameClient, removeSSEGameClient } from "../lib/gameServer";

const router = Router();

const BAU_CUA_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>🦀 Bầu Cua Haru88</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a1a;color:#fff;font-family:'Segoe UI',sans-serif;min-height:100vh;overflow-x:hidden}
.header{background:linear-gradient(135deg,#1a1a3e,#2d1b69);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #4a3aaa;position:sticky;top:0;z-index:50}
.logo{font-size:18px;font-weight:700;color:#f0c040}
.balance-box{text-align:right}
.balance-label{font-size:11px;color:#888}
.balance-val{font-size:16px;font-weight:700;color:#40e0d0}
.sync-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:6px;background:#555;transition:background .3s}
.sync-dot.ok{background:#00e878}.sync-dot.err{background:#ff4444}.sync-dot.loading{background:#f0c040}
.game-area{padding:14px;max-width:480px;margin:0 auto}
.status-bar{text-align:center;padding:10px 14px;margin-bottom:10px;border-radius:12px;font-weight:700;font-size:15px;transition:all .3s}
.s-betting{background:#1e1300;border:2px solid #cc7700;color:#ffbb33}
.s-rolling{background:#12001e;border:2px solid #7700cc;color:#cc88ff}
.s-result{background:#001222;border:2px solid #0077cc;color:#55aaff}
.s-waiting{background:#0a0a1a;border:2px solid #333;color:#777}
.dice-row{display:flex;justify-content:center;gap:14px;margin:12px 0}
.dice-box{width:80px;height:80px;border-radius:18px;background:#12122e;border:3px solid #4a3aaa;display:flex;align-items:center;justify-content:center;font-size:38px;transition:border-color .3s}
.dice-box.highlight{border-color:#f0c040;box-shadow:0 0 18px #f0c04070}
.dice-box.won{border-color:#00e878;box-shadow:0 0 18px #00e87860}
@keyframes spinY{0%{transform:rotateY(0deg)}100%{transform:rotateY(360deg)}}
.dice-box.spinning .sym-inner{display:inline-block;animation:spinY .3s linear infinite}
.result-banner{text-align:center;padding:12px 16px;border-radius:14px;margin:8px 0;font-size:17px;font-weight:700;display:none}
.r-win{background:linear-gradient(135deg,#081a08,#132613);border:2px solid #00e878;color:#00ff88}
.r-lose{background:linear-gradient(135deg,#1a0808,#330e0e);border:2px solid #ff3333;color:#ff6666}
.r-neutral{background:linear-gradient(135deg,#111,#222);border:2px solid #555;color:#aaa}
.sec-title{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.symbols-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.sym-btn{padding:10px 6px;border:2px solid #2a2a4a;border-radius:14px;background:#10102a;cursor:pointer;text-align:center;transition:all .18s;position:relative}
.sym-btn:active{transform:scale(.96)}
.sym-btn.can-bet:hover{border-color:#f0c040;transform:scale(1.03)}
.sym-btn.has-bet{border-color:#40e0d0;background:#0a2a2a}
.sym-btn:disabled{opacity:.35;cursor:not-allowed;transform:none!important}
.sym-icon{font-size:28px;display:block;margin-bottom:2px}
.sym-name{font-size:11px;font-weight:700;color:#ddd}
.sym-bet-amt{font-size:11px;color:#40e0d0;margin-top:2px;min-height:14px}
.amount-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:8px}
.amount-btn{padding:9px 4px;border:1px solid #2a2a4a;border-radius:8px;background:#10102a;color:#bbb;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s}
.amount-btn:hover{border-color:#f0c040;color:#f0c040}
.amount-btn.active{border-color:#f0c040;background:#1e1a08;color:#f0c040}
.custom-row{display:flex;gap:8px;margin-bottom:10px}
.custom-row input{flex:1;background:#10102a;border:1px solid #2a2a4a;border-radius:8px;padding:8px 12px;color:#fff;font-size:14px}
.custom-row input:focus{outline:none;border-color:#f0c040}
#payoutPanel{display:none;background:#0d0d26;border:1px solid #2a2a50;border-radius:12px;padding:12px;margin-bottom:10px}
.payout-title{font-size:12px;color:#888;margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:.8px}
.payout-row{display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid #1a1a36;font-size:12px}
.payout-row:last-child{border:none}
.payout-icon{font-size:20px;width:28px;text-align:center}
.payout-name{width:46px;font-weight:700;color:#ddd}
.payout-bet{width:56px;color:#40e0d0;font-weight:700}
.payout-cols{flex:1;display:flex;gap:6px}
.payout-cell{flex:1;text-align:center;padding:3px 4px;border-radius:6px;font-size:11px;font-weight:700}
.pc-1x{background:#1a2a1a;color:#4dffaa}
.pc-2x{background:#1a2210;color:#aaff44}
.pc-3x{background:#221a00;color:#ffdd00}
.pc-lose{background:#2a0a0a;color:#ff6666}
#resultDetail{display:none;background:#0d1a0d;border:1px solid #2a4a2a;border-radius:12px;padding:12px;margin-bottom:10px}
.rd-title{font-size:13px;color:#4dffaa;font-weight:700;margin-bottom:8px}
.rd-row{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;border-bottom:1px solid #1a2a1a}
.rd-row:last-child{border:none}
.rd-win{color:#00ff88}
.rd-lose{color:#ff6666}
.rd-total{font-weight:700;font-size:14px;padding-top:6px}
.action-bar{display:flex;gap:8px;margin-bottom:10px}
.btn-history{flex:0 0 auto;padding:10px 14px;border-radius:10px;background:#1a1a3e;border:2px solid #4a3aaa;color:#aaa;font-size:13px;font-weight:600;cursor:pointer}
.btn-history:hover{border-color:#f0c040;color:#f0c040}
.bet-hint{flex:1;padding:10px;border-radius:10px;background:#1e1a06;border:2px solid #4a3a00;color:#f0c040;font-size:12px;font-weight:600;text-align:center}
.rules-box{background:#0a0a20;border:1px solid #222244;border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12px;color:#888}
.rules-box b{color:#aaa}
.round-box{text-align:center;font-size:12px;color:#555;padding:6px 0}
.modal-overlay{position:fixed;inset:0;background:#000a;z-index:100;display:none;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal-box{background:#12122e;border:2px solid #4a3aaa;border-radius:18px;padding:20px;width:90%;max-width:360px;max-height:80vh;display:flex;flex-direction:column}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.modal-title{font-size:16px;font-weight:700;color:#f0c040}
.modal-close{background:none;border:none;color:#888;font-size:22px;cursor:pointer}
.history-list{overflow-y:auto;flex:1}
.hist-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1a1a32;font-size:14px}
.hist-item:last-child{border:none}
.hist-no{font-size:11px;color:#555;min-width:30px}
.hist-dice{display:flex;gap:6px;font-size:20px}
.hist-empty{color:#555;text-align:center;padding:20px;font-size:13px}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#222;border:1px solid #444;padding:10px 18px;border-radius:10px;font-size:13px;z-index:200;opacity:0;pointer-events:none;transition:opacity .25s;white-space:nowrap;max-width:88vw}
.toast.show{opacity:1}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🦀 BẦU CUA <span class="sync-dot" id="syncDot"></span></div>
  <div class="balance-box">
    <div class="balance-label">Số dư</div>
    <div class="balance-val" id="balance">--</div>
  </div>
</div>
<div class="game-area">
  <div id="statusBar" class="status-bar s-waiting">⏳ Đang kết nối...</div>
  <div class="dice-row">
    <div class="dice-box" id="d0"><span class="sym-inner">🎯</span></div>
    <div class="dice-box" id="d1"><span class="sym-inner">🦀</span></div>
    <div class="dice-box" id="d2"><span class="sym-inner">🦐</span></div>
  </div>
  <div id="resultBanner" class="result-banner"></div>
  <div id="resultDetail"></div>

  <div class="sec-title">Chọn con → Đặt ngay (trừ tiền tức thì)</div>
  <div class="symbols-grid">
    <button class="sym-btn" id="btn_bau" onclick="quickBet('bau')">
      <span class="sym-icon">🎯</span><div class="sym-name">BẦU</div><div class="sym-bet-amt" id="amt_bau"></div>
    </button>
    <button class="sym-btn" id="btn_cua" onclick="quickBet('cua')">
      <span class="sym-icon">🦀</span><div class="sym-name">CUA</div><div class="sym-bet-amt" id="amt_cua"></div>
    </button>
    <button class="sym-btn" id="btn_tom" onclick="quickBet('tom')">
      <span class="sym-icon">🦐</span><div class="sym-name">TÔM</div><div class="sym-bet-amt" id="amt_tom"></div>
    </button>
    <button class="sym-btn" id="btn_ca" onclick="quickBet('ca')">
      <span class="sym-icon">🐟</span><div class="sym-name">CÁ</div><div class="sym-bet-amt" id="amt_ca"></div>
    </button>
    <button class="sym-btn" id="btn_ga" onclick="quickBet('ga')">
      <span class="sym-icon">🐓</span><div class="sym-name">GÀ</div><div class="sym-bet-amt" id="amt_ga"></div>
    </button>
    <button class="sym-btn" id="btn_nai" onclick="quickBet('nai')">
      <span class="sym-icon">🦌</span><div class="sym-name">NAI</div><div class="sym-bet-amt" id="amt_nai"></div>
    </button>
  </div>

  <div class="sec-title">Số tiền mỗi lần đặt</div>
  <div class="amount-grid">
    <button class="amount-btn active" onclick="setAmt(10000,this)">10K</button>
    <button class="amount-btn" onclick="setAmt(20000,this)">20K</button>
    <button class="amount-btn" onclick="setAmt(50000,this)">50K</button>
    <button class="amount-btn" onclick="setAmt(100000,this)">100K</button>
    <button class="amount-btn" onclick="setAmt(200000,this)">200K</button>
    <button class="amount-btn" onclick="setAmt(500000,this)">500K</button>
    <button class="amount-btn" onclick="setAmt(1000000,this)">1TR</button>
    <button class="amount-btn" onclick="setAllIn(this)">TẤT CẢ</button>
  </div>
  <div class="custom-row">
    <input type="number" id="customAmt" placeholder="Nhập số tiền..." min="1000" step="1000">
  </div>

  <div id="payoutPanel">
    <div class="payout-title">🏦 Bảng trả thưởng — cược hiện tại</div>
    <div id="payoutRows"></div>
    <div style="font-size:11px;color:#555;margin-top:6px">Xuất hiện 1 lần→x2 | 2 lần→x3 | 3 lần→x4 tổng nhận</div>
  </div>

  <div class="rules-box">
    <b>Quy tắc trả thưởng:</b> Mỗi con xuất hiện trên 1 xúc xắc → thắng 1×cược (nhận lại 2×). Xuất hiện 2 lần → thắng 2× (nhận 3×). Xuất hiện 3 lần → thắng 3× (nhận 4×). Không xuất hiện → mất cược.
  </div>

  <div class="action-bar">
    <button class="btn-history" onclick="openHistory()">📋 Lịch sử</button>
  </div>
  <div class="round-box" id="roundBox">🔗 Đang kết nối server...</div>
</div>

<div class="toast" id="toast"></div>

<div class="modal-overlay" id="histModal" onclick="if(event.target===this)closeHistory()">
  <div class="modal-box">
    <div class="modal-header">
      <span class="modal-title">📋 Lịch sử kết quả</span>
      <button class="modal-close" onclick="closeHistory()">✕</button>
    </div>
    <div class="history-list" id="histList"><div class="hist-empty">Chưa có kết quả</div></div>
  </div>
</div>

<script>
/* ── Constants ─────────────────────────────── */
const EMOJI={bau:'🎯',cua:'🦀',tom:'🦐',ca:'🐟',ga:'🐓',nai:'🦌'};
const KEYS=['bau','cua','tom','ca','ga','nai'];
const SYMS=KEYS.map(k=>EMOJI[k]);
const API='/api';

/* ── State ─────────────────────────────────── */
let tgId=new URLSearchParams(location.search).get('tgid')||'';
(function(){const tg=window.Telegram?.WebApp;if(tg){tg.ready();tg.expand();const u=tg.initDataUnsafe?.user;if(u?.id)tgId=String(u.id);}})();

let serverBalance=0;
let localBets={};
let lastPot={};
let selectedAmt=10000;
let bettingOpen=false;
let currentPhase='';
let currentRound=0;
let settledRound=-1;
let displayedResultSession=-1;
let spinInterval=null;
let history=[];
let isAllInMode=false;
let sse=null;

/* ── Utils ─────────────────────────────────── */
function fmt(n){return Math.round(n).toLocaleString('vi-VN')}
let _toastTimer=null;
function showToast(msg,d=2200){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  if(_toastTimer)clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>t.classList.remove('show'),d);
}
function syncDot(state){
  const d=document.getElementById('syncDot');
  d.className='sync-dot'; if(state) d.classList.add(state);
}

/* ── Display balance (deducting staged bets) ─ */
function totalStagedBets(){return Object.values(localBets).reduce((s,v)=>s+v,0);}
function displayBalance(){return Math.max(0,serverBalance-totalStagedBets());}
function updateBalanceDisplay(){document.getElementById('balance').textContent=fmt(displayBalance())+'đ';}

/* ── Amount selection ───────────────────────── */
function setAmt(v,btn){
  selectedAmt=v;isAllInMode=false;
  document.getElementById('customAmt').value='';
  document.querySelectorAll('.amount-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
function setAllIn(btn){
  isAllInMode=true;selectedAmt=0;
  document.getElementById('customAmt').value='';
  document.querySelectorAll('.amount-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
document.getElementById('customAmt').addEventListener('input',function(){
  selectedAmt=parseInt(this.value)||0;isAllInMode=false;
  document.querySelectorAll('.amount-btn').forEach(b=>b.classList.remove('active'));
});
function getAmt(){
  if(isAllInMode) return displayBalance();
  const cv=parseInt(document.getElementById('customAmt').value)||0;
  return cv>0?cv:selectedAmt;
}

/* ── Quick bet (immediate deduction + server) ─ */
function quickBet(type){
  if(!bettingOpen){showToast('⏳ Phiên đặt cược đã đóng!');return;}
  const amt=getAmt();
  if(!amt||amt<1000){showToast('❌ Nhập số tiền tối thiểu 1,000đ!');return;}
  if(amt>displayBalance()){showToast('❌ Số dư không đủ!');return;}
  localBets[type]=(localBets[type]||0)+amt;
  updateBalanceDisplay();renderBetLabels();renderPayoutTable();
  showToast('✅ Đặt '+fmt(amt)+'đ vào '+EMOJI[type]+' '+type.toUpperCase());
  fetch(API+'/games/bau-cua-bet',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({tgid:tgId,betType:type,amount:amt})
  }).then(r=>r.json()).then(d=>{
    if(!d.success){
      localBets[type]-=amt;
      if(localBets[type]<=0)delete localBets[type];
      updateBalanceDisplay();renderBetLabels();renderPayoutTable();
      showToast('❌ '+d.message);
    }
  }).catch(()=>showToast('❌ Lỗi kết nối!'));
}

function renderBetLabels(){
  KEYS.forEach(k=>{
    const amtEl=document.getElementById('amt_'+k);
    const btn=document.getElementById('btn_'+k);
    const pot=lastPot[k]||0;
    let html='';
    if(localBets[k]){
      html='<span style="color:#40e0d0">'+fmt(localBets[k])+'đ</span>';
      btn.classList.add('has-bet');
    } else {
      btn.classList.remove('has-bet');
    }
    if(pot>0){
      html+=(html?'<br>':'')+'<span style="color:#888;font-size:10px">Tổng: '+fmt(pot)+'đ</span>';
    }
    amtEl.innerHTML=html;
  });
}

/* ── Payout table ───────────────────────────── */
function renderPayoutTable(){
  const panel=document.getElementById('payoutPanel');
  const rows=document.getElementById('payoutRows');
  const hasBets=Object.keys(localBets).length>0;
  if(!hasBets){panel.style.display='none';return;}
  panel.style.display='block';
  let html='';
  for(const[k,amt]of Object.entries(localBets)){
    const x1=amt*2,x2=amt*3,x3=amt*4;
    html+=\`<div class="payout-row">
      <span class="payout-icon">\${EMOJI[k]}</span>
      <span class="payout-name">\${k.toUpperCase()}</span>
      <span class="payout-bet">\${fmt(amt)}đ</span>
      <div class="payout-cols">
        <div class="payout-cell pc-1x">1×<br>\${fmt(x1)}đ</div>
        <div class="payout-cell pc-2x">2×<br>\${fmt(x2)}đ</div>
        <div class="payout-cell pc-3x">3×<br>\${fmt(x3)}đ</div>
        <div class="payout-cell pc-lose">thua<br>-\${fmt(amt)}đ</div>
      </div>
    </div>\`;
  }
  rows.innerHTML=html;
}

/* ── Betting controls ───────────────────────── */
function enableBetting(){
  bettingOpen=true;
  document.querySelectorAll('.sym-btn').forEach(b=>{b.disabled=false;b.classList.add('can-bet');});
}
function disableBetting(){
  bettingOpen=false;
  document.querySelectorAll('.sym-btn').forEach(b=>{b.disabled=true;b.classList.remove('can-bet');});
}

/* ── Dice animation ─────────────────────────── */
function startSpin(){
  stopSpin();
  ['d0','d1','d2'].forEach(id=>document.getElementById(id).classList.add('spinning'));
  let fi=0;
  spinInterval=setInterval(()=>{
    KEYS.forEach((_,i)=>{
      const el=document.getElementById('d'+i);
      if(el)el.querySelector('.sym-inner').textContent=SYMS[(fi+i)%SYMS.length];
    });
    fi++;
  },120);
}
function stopSpin(){
  if(spinInterval){clearInterval(spinInterval);spinInterval=null;}
  ['d0','d1','d2'].forEach(id=>document.getElementById(id).classList.remove('spinning'));
}
function showResultDice(dice){
  stopSpin();
  ['d0','d1','d2'].forEach((id,i)=>{
    const el=document.getElementById(id);
    el.querySelector('.sym-inner').textContent=EMOJI[dice[i]]||dice[i]||'?';
    el.classList.remove('spinning');el.classList.add('highlight');
    if(localBets[dice[i]])el.classList.add('won');
  });
}
function resetDice(){
  stopSpin();
  ['d0','d1','d2'].forEach((id,i)=>{
    const el=document.getElementById(id);
    el.querySelector('.sym-inner').textContent=SYMS[i];
    el.classList.remove('highlight','won','spinning');
  });
}

/* ── History modal ──────────────────────────── */
function openHistory(){
  if(history.length===0){
    document.getElementById('histList').innerHTML='<div class="hist-empty">Chưa có kết quả</div>';
  } else {
    document.getElementById('histList').innerHTML=history.map(h=>
      \`<div class="hist-item">
        <span class="hist-no">#\${h.round}</span>
        <span class="hist-dice">\${h.dice.map(d=>EMOJI[d]||d).join(' ')}</span>
      </div>\`
    ).join('');
  }
  document.getElementById('histModal').classList.add('open');
}
function closeHistory(){document.getElementById('histModal').classList.remove('open');}

/* ── Settle result ──────────────────────────── */
function settle(dice,round){
  if(settledRound===round)return;
  settledRound=round;
  const hasBets=Object.keys(localBets).length>0;
  if(!hasBets){localBets={};return;}
  const totalBet=totalStagedBets();
  let totalReturn=0;let detailRows='';let netOverall=0;
  for(const[betType,amt]of Object.entries(localBets)){
    const count=dice.filter(d=>d===betType).length;
    if(count>0){
      const ret=amt*(count+1);const profit=ret-amt;
      totalReturn+=ret;netOverall+=profit;
      detailRows+=\`<div class="rd-row"><span>\${EMOJI[betType]} \${betType.toUpperCase()} × \${count}</span><span class="rd-win">+\${fmt(profit)}đ → nhận \${fmt(ret)}đ</span></div>\`;
    } else {
      netOverall-=amt;
      detailRows+=\`<div class="rd-row"><span>\${EMOJI[betType]} \${betType.toUpperCase()} × 0</span><span class="rd-lose">-\${fmt(amt)}đ</span></div>\`;
    }
  }
  const net=totalReturn-totalBet;
  const detailColor=net>=0?'rd-win':'rd-lose';
  const sign=net>=0?'+':'';
  const detailHtml=\`<div style="display:block;background:#0d1a0d;border:1px solid #2a4a2a;border-radius:12px;padding:12px;margin-bottom:10px">
    <div class="rd-title">📊 Chi tiết kết quả phiên #\${round}</div>
    \${detailRows}
    <div class="rd-row rd-total"><span>Tổng</span><span class="\${detailColor}">\${sign}\${fmt(net)}đ</span></div>
  </div>\`;
  document.getElementById('resultDetail').outerHTML=detailHtml;
  const banner=document.getElementById('resultBanner');
  if(net>0){banner.className='result-banner r-win';banner.textContent='🎉 THẮNG '+fmt(net)+'đ!';}
  else if(net<0){banner.className='result-banner r-lose';banner.textContent='😢 Thua '+fmt(Math.abs(net))+'đ';}
  else{banner.className='result-banner r-neutral';banner.textContent='Hoà — không thắng không thua';}
  banner.style.display='block';
  localBets={};renderBetLabels();renderPayoutTable();
}

/* ── SSE Connection ─────────────────────────── */
function connect(){
  if(sse){try{sse.close();}catch{}}
  sse=new EventSource(API+'/games/bau-cua-stream?tgid='+encodeURIComponent(tgId));
  sse.onmessage=e=>{try{handleMsg(JSON.parse(e.data));}catch{}};
  sse.onerror=()=>{syncDot('err');sse.close();setTimeout(connect,3000);};
}

function handleMsg(m){
  if(m.type==='init'){
    serverBalance=m.balance;syncDot('ok');updateBalanceDisplay();
  } else if(m.type==='state'){
    handleGameState(m);
  } else if(m.type==='balance_update'){
    serverBalance=m.balance;
    localBets={};renderBetLabels();renderPayoutTable();
    updateBalanceDisplay();syncDot('ok');
  }
}

function handleGameState(m){
  if(m.pot){lastPot=m.pot;renderBetLabels();}
  if(m.state==='waiting'){
    if(currentPhase!=='waiting'){
      localBets={};renderBetLabels();
      document.getElementById('resultBanner').style.display='none';
      const rd=document.getElementById('resultDetail');
      if(rd)rd.style.display='none';
      renderPayoutTable();resetDice();enableBetting();
    }
    const sb=document.getElementById('statusBar');
    sb.className='status-bar s-waiting';
    sb.textContent='⏳ Đặt cược để bắt đầu phiên mới...';
    document.getElementById('roundBox').textContent='Phiên #'+(m.sessionId||0)+' đã kết thúc — Đặt cược để bắt đầu!';
  } else if(m.state==='countdown'){
    if(currentPhase!=='countdown'){
      document.getElementById('resultBanner').style.display='none';
      const rd=document.getElementById('resultDetail');if(rd)rd.style.display='none';
      resetDice();enableBetting();renderPayoutTable();localBets={};renderBetLabels();
    }
    const cdVal=m.countdown;
    const sb=document.getElementById('statusBar');
    sb.className='status-bar s-betting';
    const color=cdVal<=5?'#ff4444':cdVal<=10?'#ff9900':'#ffbb33';
    sb.innerHTML=\`⏰ Phiên <b>#\${m.sessionId}</b> — Đặt cược: <b style="font-size:20px;color:\${color}">\${cdVal}s</b>\`;
    document.getElementById('roundBox').textContent='Phiên #'+m.sessionId+' · Còn '+cdVal+'s đặt cược';
  } else if(m.state==='playing'){
    disableBetting();
    const sb=document.getElementById('statusBar');
    sb.className='status-bar s-rolling';
    sb.innerHTML=\`🎲 Phiên <b>#\${m.sessionId}</b> — Đang lắc xúc xắc...\`;
    document.getElementById('roundBox').textContent='Phiên #'+m.sessionId+' · Đang tung xúc xắc!';
    startSpin();
  } else if(m.state==='result'&&m.result){
    if(displayedResultSession!==m.sessionId){
      displayedResultSession=m.sessionId;
      const dice=m.result.dice;
      history.unshift({round:m.sessionId,dice:[...dice]});
      if(history.length>50)history.pop();
      setTimeout(()=>{
        showResultDice(dice);settle(dice,m.sessionId);
        const sb=document.getElementById('statusBar');
        sb.className='status-bar s-result';
        sb.innerHTML=\`🏆 Phiên <b>#\${m.sessionId}</b> — \${dice.map(d=>EMOJI[d]||d).join(' ')}\`;
      },2000);
    }
  }
  currentPhase=m.state;currentRound=m.sessionId||currentRound;
}

/* ── Entry ──────────────────────────────────── */
if(!tgId){
  document.body.innerHTML=\`<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a1a">
    <div style="background:#12122e;border:2px solid #4a3aaa;border-radius:18px;padding:30px 24px;max-width:340px;width:90%;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">🎯🦀🦐</div>
      <h2 style="color:#f0c040;font-size:20px;margin-bottom:8px">Bầu Cua Haru88</h2>
      <p style="color:#888;font-size:14px">Vui lòng mở game từ bot Telegram</p>
    </div>
  </div>\`;
} else {
  connect();
}
</script>
</body>
</html>`;

router.get("/games/bau-cua", (_req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(BAU_CUA_HTML);
});

router.get("/games/bau-cua-stream", async (req: Request, res: Response): Promise<void> => {
  const tgId = req.query.tgid as string;
  if (!tgId) { res.status(400).json({ error: "tgid required" }); return; }

  const user = await storage.getBotUser(tgId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const balance = parseFloat(user.balance);
  const name = user.firstName || user.username || `Player${tgId.slice(-4)}`;
  const gameType = "baucua";

  gameServer.joinRoomSSE(tgId, gameType, name, balance);
  registerSSEGameClient(tgId, gameType, res);

  res.write(`data: ${JSON.stringify({ type: "init", balance, name })}\n\n`);
  res.write(`data: ${JSON.stringify(gameServer.getSnapshot(gameType))}\n\n`);

  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { cleanup(); }
  }, 25000);

  function cleanup() {
    clearInterval(keepalive);
    removeSSEGameClient(tgId, gameType);
    gameServer.removePlayer(tgId, gameType);
  }

  req.on("close", cleanup);
});

router.post("/games/bau-cua-bet", async (req: Request, res: Response): Promise<void> => {
  const { tgid, betType, amount } = req.body;
  if (!tgid || !betType || amount == null) {
    res.status(400).json({ success: false, message: "Missing params" });
    return;
  }
  if (!/^\d{5,15}$/.test(String(tgid))) {
    res.status(400).json({ success: false, message: "Invalid tgid" });
    return;
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    res.status(400).json({ success: false, message: "Amount must be a positive number" });
    return;
  }
  const result = await gameServer.placeBet(String(tgid), "baucua", String(betType), amountNum);
  res.json(result);
});

export default router;
