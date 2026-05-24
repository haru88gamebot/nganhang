import { Router, type Request, type Response } from "express";
import { registerSSEClient, handleBet, handleCashout, getGameState } from "../lib/crashGame";
import { storage } from "../lib/storage";

const router = Router();

/* ─────────────────────────────────────────────────────────── */
/*  Inline HTML — Máy Bay (Crash Game)                         */
/* ─────────────────────────────────────────────────────────── */
const MAY_BAY_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>✈️ Máy Bay</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#060910;color:#fff;font-family:'Segoe UI',sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden;user-select:none}

/* Header */
#header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:rgba(17,24,39,.95);border-bottom:1px solid #1f2937;z-index:10;position:relative}
#balance-val{color:#10b981;font-weight:700;font-size:15px}
#round-info{font-size:12px;color:#6b7280}

/* History bar */
#history-bar{display:flex;gap:5px;padding:6px 12px;overflow-x:auto;background:rgba(17,24,39,.9);border-bottom:1px solid #1f2937;min-height:34px;align-items:center;scrollbar-width:none;z-index:10;position:relative}
#history-bar::-webkit-scrollbar{display:none}
.hist-chip{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap}
.low{background:#7f1d1d;color:#fca5a5}.mid{background:#78350f;color:#fcd34d}.high{background:#064e3b;color:#6ee7b7}.ultra{background:#4c1d95;color:#c4b5fd}

/* Game area */
#game-area{flex:1;position:relative;min-height:0;overflow:hidden}
canvas#graph{position:absolute;inset:0;width:100%;height:100%}

/* ── IDLE SCREEN ── */
#idle-screen{
  position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 35%, #0c1f3a 0%, #060910 65%);
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  z-index:5;
}
#idle-stars{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.star{position:absolute;border-radius:50%;background:#fff}
@keyframes twinkle{0%,100%{opacity:.2}50%{opacity:.9;transform:scale(1.4)}}

#idle-plane-wrap{position:relative;margin-bottom:8px}
#idle-plane-svg{
  width:90px;height:72px;
  filter:drop-shadow(0 0 18px rgba(16,185,129,.9));
  animation:floatPlane 3.5s ease-in-out infinite;
}
@keyframes floatPlane{
  0%,100%{transform:translate(0,0) rotate(-6deg)}
  30%{transform:translate(8px,-14px) rotate(-9deg)}
  65%{transform:translate(-6px,-8px) rotate(-4deg)}
}
#idle-trail{
  position:absolute;right:-14px;top:50%;transform:translateY(-50%);
  width:36px;height:4px;
  background:linear-gradient(to left,rgba(16,185,129,.0),rgba(16,185,129,.6));
  border-radius:4px;
  animation:trailPulse 3.5s ease-in-out infinite;
}
@keyframes trailPulse{0%,100%{opacity:.3;width:26px}30%{opacity:.9;width:46px}65%{opacity:.5;width:32px}}

.idle-title{font-size:22px;font-weight:900;color:#10b981;letter-spacing:.5px;animation:glowText 2.2s ease-in-out infinite;margin-bottom:6px}
@keyframes glowText{0%,100%{text-shadow:0 0 8px #10b981}50%{text-shadow:0 0 22px #10b981,0 0 40px #10b981}}
.idle-sub{font-size:13px;color:#4b5563;margin-bottom:18px}
#idle-bet-badge{
  display:none;
  background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);
  color:#f59e0b;font-size:12px;font-weight:600;
  padding:6px 14px;border-radius:20px;
  animation:pulseBadge 1s ease-in-out infinite alternate;
}
@keyframes pulseBadge{from{box-shadow:0 0 0 #f59e0b}to{box-shadow:0 0 10px 2px rgba(245,158,11,.3)}}

/* ── WAITING COUNTDOWN SCREEN ── */
#wait-screen{
  position:absolute;inset:0;
  background:radial-gradient(ellipse at 50% 40%, #0d1f38 0%, #060910 65%);
  display:none;flex-direction:column;align-items:center;justify-content:center;
  z-index:5;
}
.wait-label{font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:16px}
.wait-ring-wrap{position:relative;width:150px;height:150px;margin-bottom:14px}
.ring-svg{transform:rotate(-90deg);width:150px;height:150px}
.ring-bg{fill:none;stroke:#1f2937;stroke-width:10}
.ring-fg{fill:none;stroke-width:10;stroke-linecap:round;stroke-dasharray:440;transition:stroke-dashoffset .2s linear}
.ring-center{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  text-align:center;
}
#wait-num{font-size:52px;font-weight:900;color:#fff;line-height:1}
#wait-sec-label{font-size:11px;color:#6b7280;margin-top:2px}
#wait-player-count{
  font-size:13px;font-weight:600;color:#f59e0b;
  background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);
  padding:5px 14px;border-radius:16px;margin-bottom:10px
}
#wait-msg{font-size:13px;color:#4b5563}

/* ── Multiplier overlay (flying/crashed) ── */
#center-display{
  position:absolute;top:46%;left:50%;transform:translate(-50%,-50%);
  text-align:center;pointer-events:none;z-index:3;
}
#multiplier-display{font-size:64px;font-weight:900;letter-spacing:-2px;text-shadow:0 0 30px currentColor;line-height:1}
#multiplier-display.flying{color:#10b981}
#multiplier-display.crashed{color:#ef4444}
#status-text{font-size:13px;color:#9ca3af;margin-top:6px;min-height:18px}

/* ── Crash overlay ── */
#crash-overlay{
  display:none;position:absolute;inset:0;z-index:4;
  background:rgba(239,68,68,.08);
  border:2px solid rgba(239,68,68,.35);
  border-radius:4px;
  align-items:center;justify-content:center;flex-direction:column;gap:3px;
  pointer-events:none;
}
#crash-overlay.show{display:flex}
#crash-boom{font-size:28px;font-weight:900;color:#ef4444;animation:boom .3s ease-out}
@keyframes boom{from{transform:scale(1.6)}to{transform:scale(1)}}

/* Controls */
#controls{padding:10px 14px 12px;background:rgba(17,24,39,.97);border-top:1px solid #1f2937;flex-shrink:0}
#my-bet-info{text-align:center;font-size:12px;color:#f59e0b;min-height:16px;margin-bottom:6px}
#quick-bets{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px}
.qbet{background:#1f2937;border:1px solid #374151;border-radius:7px;padding:5px 9px;font-size:12px;color:#d1d5db;cursor:pointer;transition:all .12s}
.qbet:active,.qbet.active{background:#374151;border-color:#6b7280}
#bet-row{display:flex;gap:8px;margin-bottom:8px}
#bet-input{flex:1;background:#1f2937;border:1.5px solid #374151;border-radius:9px;color:#fff;font-size:16px;padding:9px 12px;outline:none}
#bet-input:focus{border-color:#3b82f6}
#bet-input:disabled{opacity:.45}
#action-btn{width:100%;padding:13px;border-radius:11px;border:none;font-size:17px;font-weight:700;cursor:pointer;transition:all .15s}
.btn-bet{background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff}
.btn-cashout{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;animation:cashPulse .6s infinite alternate}
.btn-wait{background:#374151;color:#6b7280;cursor:not-allowed}
@keyframes cashPulse{to{box-shadow:0 0 20px 4px rgba(245,158,11,.3)}}

#toast{position:fixed;bottom:96px;left:50%;transform:translateX(-50%);background:#1f2937;border:1px solid #374151;border-radius:10px;padding:9px 18px;font-size:13px;color:#fff;opacity:0;transition:opacity .3s;pointer-events:none;z-index:99;white-space:nowrap;max-width:92vw}
</style>
</head>
<body>

<div id="header">
  <div style="font-size:13px;color:#9ca3af">💰 <span id="balance-val">--</span></div>
  <div id="round-info">Phiên #<span id="round-num">-</span></div>
</div>

<div id="history-bar"><span style="font-size:11px;color:#4b5563;white-space:nowrap">Lịch sử:</span></div>

<div id="game-area">
  <canvas id="graph"></canvas>

  <!-- Idle screen -->
  <div id="idle-screen">
    <div id="idle-stars"></div>
    <div id="idle-plane-wrap">
      <svg id="idle-plane-svg" viewBox="0 0 90 72">
        <!-- Flame -->
        <ellipse cx="12" cy="36" rx="14" ry="5" fill="url(#flameGrad)" opacity=".9"/>
        <!-- Body -->
        <ellipse cx="48" cy="36" rx="30" ry="10" fill="#ddeeff"/>
        <!-- Nose -->
        <polygon points="76,36 82,32 82,40" fill="#aaccff"/>
        <!-- Wing top -->
        <polygon points="52,26 68,12 68,26" fill="#88aace"/>
        <!-- Wing bottom -->
        <polygon points="52,46 68,60 68,46" fill="#88aace"/>
        <!-- Tail fin -->
        <polygon points="20,26 28,14 34,26" fill="#7799bb"/>
        <!-- Window -->
        <ellipse cx="60" cy="32" rx="6" ry="8" fill="#44aaff" opacity=".7"/>
        <defs>
          <linearGradient id="flameGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="rgba(255,60,0,0)"/>
            <stop offset="60%" stop-color="rgba(255,120,20,.7)"/>
            <stop offset="100%" stop-color="rgba(255,200,50,.95)"/>
          </linearGradient>
        </defs>
      </svg>
      <div id="idle-trail"></div>
    </div>
    <div class="idle-title">SẴN SÀNG CẤT CÁNH</div>
    <div class="idle-sub">Đặt cược để bắt đầu đếm ngược</div>
    <div id="idle-bet-badge">✈️ Bắt đầu sau khi bạn đặt cược</div>
  </div>

  <!-- Waiting countdown screen -->
  <div id="wait-screen">
    <div class="wait-label">Đang chuẩn bị cất cánh</div>
    <div id="wait-player-count">👥 0 người đã đặt cược</div>
    <div class="wait-ring-wrap">
      <svg class="ring-svg" viewBox="0 0 150 150">
        <defs>
          <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#3b82f6"/>
            <stop offset="100%" stop-color="#10b981"/>
          </linearGradient>
        </defs>
        <circle class="ring-bg" cx="75" cy="75" r="70"/>
        <circle class="ring-fg" id="ring-fg" cx="75" cy="75" r="70" stroke="url(#ringGrad)"/>
      </svg>
      <div class="ring-center">
        <div id="wait-num">8</div>
        <div id="wait-sec-label">giây</div>
      </div>
    </div>
    <div id="wait-msg">Đặt cược trước khi máy bay cất cánh!</div>
  </div>

  <!-- Multiplier display (flying/crashed) -->
  <div id="center-display" style="display:none">
    <div id="multiplier-display" class="flying">1.00x</div>
    <div id="status-text"></div>
  </div>

  <!-- Crash overlay -->
  <div id="crash-overlay">
    <div id="crash-boom">💥 NỔTUNG!</div>
    <div id="crash-at-text" style="color:#ef4444;font-size:18px;font-weight:700"></div>
  </div>
</div>

<div id="controls">
  <div id="my-bet-info"></div>
  <div id="quick-bets">
    <div class="qbet" onclick="setAmt(10000,this)">10K</div>
    <div class="qbet" onclick="setAmt(20000,this)">20K</div>
    <div class="qbet" onclick="setAmt(50000,this)">50K</div>
    <div class="qbet" onclick="setAmt(100000,this)">100K</div>
    <div class="qbet" onclick="setAmt(200000,this)">200K</div>
    <div class="qbet" onclick="setAmt(500000,this)">500K</div>
  </div>
  <div id="bet-row">
    <input id="bet-input" type="number" min="1000" step="1000" placeholder="Số tiền cược...">
  </div>
  <button id="action-btn" class="btn-bet" onclick="onAction()">🎯 ĐẶT CƯỢC</button>
</div>

<div id="toast"></div>

<script>
const tgId=new URLSearchParams(location.search).get('tgid')||'';
const API='/api/games';
let phase='idle',myBet=0,myCashedOut=false,balance=0;
let currentMul=1.0,roundId=0,flyPts=[],maxWait=8,curWait=8,betCountNum=0;
let sse=null,reconnectTimer=null;

// Canvas setup
const canvas=document.getElementById('graph');
const ctx=canvas.getContext('2d');
function resizeCanvas(){
  canvas.width=canvas.offsetWidth*window.devicePixelRatio||canvas.offsetWidth;
  canvas.height=canvas.offsetHeight*window.devicePixelRatio||canvas.offsetHeight;
  ctx.scale(window.devicePixelRatio||1,window.devicePixelRatio||1);
  drawGraph();
}
window.addEventListener('resize',resizeCanvas);
setTimeout(resizeCanvas,100);
function W(){return canvas.offsetWidth;}
function H(){return canvas.offsetHeight;}

/* ── Stars for idle screen ─────────────────── */
function createStars(){
  const c=document.getElementById('idle-stars');
  c.innerHTML='';
  for(let i=0;i<55;i++){
    const s=document.createElement('div');
    const sz=Math.random()*2+1;
    s.className='star';
    s.style.cssText='width:'+sz+'px;height:'+sz+'px;left:'+Math.random()*100+'%;top:'+Math.random()*100+'%;animation:twinkle '+(1.5+Math.random()*3)+'s '+(Math.random()*3)+'s infinite';
    c.appendChild(s);
  }
}
createStars();

/* ── Canvas plane drawing ──────────────────── */
function drawPlane(x,y,tilt,crashed){
  const s=20;
  ctx.save();
  ctx.translate(x,y);
  ctx.rotate(tilt);
  if(!crashed){
    ctx.shadowBlur=14;ctx.shadowColor='#10b981';
    const fg=ctx.createLinearGradient(-s*2.4,0,-s*.7,0);
    fg.addColorStop(0,'transparent');
    fg.addColorStop(.5,'rgba(255,80,0,.35)');
    fg.addColorStop(1,'rgba(255,180,50,.9)');
    ctx.beginPath();ctx.ellipse(-s*1.5,0,s*.85,s*.24,0,0,Math.PI*2);
    ctx.fillStyle=fg;ctx.fill();
  }else{
    ctx.shadowBlur=22;ctx.shadowColor='#ef4444';
  }
  ctx.beginPath();ctx.ellipse(0,0,s*.9,s*.3,0,0,Math.PI*2);
  ctx.fillStyle=crashed?'#cc5555':'#ddeeff';ctx.fill();
  ctx.beginPath();ctx.moveTo(s*.8,0);ctx.lineTo(s*1.18,-s*.13);ctx.lineTo(s*1.18,s*.13);ctx.closePath();
  ctx.fillStyle=crashed?'#aa3333':'#aaccff';ctx.fill();
  ctx.beginPath();ctx.moveTo(s*.1,-s*.3);ctx.lineTo(s*.58,-s*.92);ctx.lineTo(s*.58,-s*.3);ctx.closePath();
  ctx.fillStyle=crashed?'#bb3333':'#88aace';ctx.fill();
  ctx.beginPath();ctx.moveTo(s*.1,s*.3);ctx.lineTo(s*.58,s*.92);ctx.lineTo(s*.58,s*.3);ctx.closePath();
  ctx.fillStyle=crashed?'#bb3333':'#88aace';ctx.fill();
  ctx.beginPath();ctx.moveTo(-s*.7,-s*.3);ctx.lineTo(-s*.45,-s*.68);ctx.lineTo(-s*.25,-s*.3);ctx.closePath();
  ctx.fillStyle='#7799bb';ctx.fill();
  ctx.beginPath();ctx.ellipse(s*.28,-s*.1,s*.1,s*.15,-.2,0,Math.PI*2);
  ctx.fillStyle='#44aaff88';ctx.fill();
  ctx.shadowBlur=0;
  ctx.restore();
}

/* ── Graph drawing ─────────────────────────── */
function drawGraph(){
  const w=W(),h=H();
  ctx.clearRect(0,0,w,h);
  if(flyPts.length<2)return;
  const maxM=Math.max(...flyPts,1.5),minM=1.0,pad=16;
  const iH=h-pad*2,iW=w-pad;
  const xStep=iW/Math.max(flyPts.length-1,1);
  const toY=m=>h-pad-((m-minM)/(maxM-minM+.12))*iH;
  const color=phase==='crashed'?'#ef4444':'#10b981';
  const pts=flyPts.map((m,i)=>({x:pad/2+i*xStep,y:toY(m)}));

  // Gradient fill
  ctx.beginPath();
  pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
  ctx.lineTo(pts[pts.length-1].x,h-pad);ctx.lineTo(pts[0].x,h-pad);ctx.closePath();
  const grd=ctx.createLinearGradient(0,0,0,h);
  grd.addColorStop(0,phase==='crashed'?'rgba(239,68,68,.22)':'rgba(16,185,129,.22)');
  grd.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=grd;ctx.fill();

  // Line
  ctx.beginPath();
  pts.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y));
  ctx.strokeStyle=color;ctx.lineWidth=2.5;
  ctx.shadowColor=color;ctx.shadowBlur=8;ctx.stroke();ctx.shadowBlur=0;

  // Grid lines (horizontal)
  ctx.strokeStyle='rgba(255,255,255,.04)';ctx.lineWidth=1;
  [1.5,2,3,5,10,20].forEach(v=>{
    if(v>maxM)return;
    const y=toY(v);
    ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,.2)';ctx.font='10px sans-serif';
    ctx.fillText(v+'x',4,y-3);
  });

  // Plane
  if(flyPts.length>1){
    const li=flyPts.length-1;
    const p=pts[li];
    let tilt=-0.22;
    if(li>5){
      const prev=pts[Math.max(0,li-8)];
      tilt=Math.atan2(p.y-prev.y,p.x-prev.x);
    }
    drawPlane(p.x,p.y,phase==='crashed'?0.7:tilt,phase==='crashed');
  }
}

/* ── UI Helpers ────────────────────────────── */
function fmtN(n){return Math.floor(n).toLocaleString('vi-VN')+'đ'}
function fmtM(m){return m.toFixed(2)+'x'}
function setAmt(v,btn){
  document.getElementById('bet-input').value=v;
  document.querySelectorAll('.qbet').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
}
function setBalance(b){balance=b;document.getElementById('balance-val').textContent=fmtN(b);}

let _tt=null;
function toast(msg,c){
  const t=document.getElementById('toast');t.textContent=msg;t.style.color=c||'#fff';t.style.opacity='1';
  clearTimeout(_tt);_tt=setTimeout(()=>{t.style.opacity='0'},2800);
}

function updateRing(tl){
  curWait=tl;
  const frac=Math.max(0,Math.min(1,tl/maxWait));
  document.getElementById('ring-fg').style.strokeDashoffset=440*(1-frac);
  document.getElementById('wait-num').textContent=Math.ceil(tl);
}

function updatePlayerCount(n){
  betCountNum=n;
  document.getElementById('wait-player-count').textContent='👥 '+n+' người đã đặt cược';
}

function updateBetInfo(){
  const el=document.getElementById('my-bet-info');
  if(myBet>0&&!myCashedOut&&phase==='flying')
    el.textContent='✈️ Đang bay: '+fmtN(myBet)+' → '+fmtN(Math.floor(myBet*currentMul))+' ('+fmtM(currentMul)+')';
  else if(myBet>0&&(phase==='waiting'||phase==='idle'))
    el.textContent='✅ Đã đặt: '+fmtN(myBet)+' — Chờ cất cánh...';
  else el.textContent='';
}

/* ── Screen switching ──────────────────────── */
function showScreen(s){
  document.getElementById('idle-screen').style.display=s==='idle'?'flex':'none';
  document.getElementById('wait-screen').style.display=s==='wait'?'flex':'none';
  document.getElementById('center-display').style.display=(s==='fly'||s==='crash')?'block':'none';
  document.getElementById('crash-overlay').className=s==='crash'?'show':'';
  canvas.style.opacity=(s==='fly'||s==='crash')?'1':'0';
}

function renderBtn(){
  const btn=document.getElementById('action-btn');
  const inp=document.getElementById('bet-input');
  if(phase==='idle'||phase==='waiting'){
    if(myBet>0){
      btn.className='btn-wait';btn.textContent='✅ Đã đặt '+fmtN(myBet);btn.disabled=true;inp.disabled=true;
    }else{
      btn.className='btn-bet';btn.textContent='🎯 ĐẶT CƯỢC';btn.disabled=false;inp.disabled=false;
    }
  }else if(phase==='flying'){
    if(myBet>0&&!myCashedOut){
      btn.className='btn-cashout';btn.textContent='💸 RÚT '+fmtN(Math.floor(myBet*currentMul));btn.disabled=false;inp.disabled=true;
    }else if(myCashedOut){
      btn.className='btn-wait';btn.textContent='✅ Đã rút thành công!';btn.disabled=true;inp.disabled=true;
    }else{
      btn.className='btn-wait';btn.textContent='⏰ Phiên sau để đặt cược';btn.disabled=true;inp.disabled=true;
    }
  }else{
    btn.className='btn-wait';btn.textContent='⏳ Chuẩn bị phiên mới...';btn.disabled=true;inp.disabled=true;
    inp.value='';
  }
}

/* ── Msg handler ───────────────────────────── */
function handleMsg(msg){
  if(msg.type==='init'){
    phase=msg.phase;currentMul=msg.multiplier||1.0;roundId=msg.roundId;
    curWait=msg.timeLeft||8;maxWait=8;
    if(typeof msg.balance==='number')setBalance(msg.balance);
    document.getElementById('round-num').textContent=roundId;
    if(msg.history)renderHistory(msg.history);
    if(msg.betCount)updatePlayerCount(msg.betCount);
    if(phase==='idle'){showScreen('idle');}
    else if(phase==='waiting'){showScreen('wait');updateRing(curWait);}
    else if(phase==='flying'){flyPts=[1.0,currentMul];showScreen('fly');drawGraph();
      document.getElementById('multiplier-display').className='flying';
      document.getElementById('multiplier-display').textContent=fmtM(currentMul);}
    else if(phase==='crashed'){flyPts=[1.0,currentMul];showScreen('crash');drawGraph();
      document.getElementById('multiplier-display').className='crashed';
      document.getElementById('multiplier-display').textContent=fmtM(currentMul);}
    renderBtn();updateBetInfo();

  }else if(msg.type==='phase'){
    const prev=phase;
    phase=msg.phase;roundId=msg.roundId||roundId;
    document.getElementById('round-num').textContent=roundId;

    if(msg.phase==='idle'){
      myBet=0;myCashedOut=false;currentMul=1.0;flyPts=[];
      if(msg.history)renderHistory(msg.history);
      showScreen('idle');
    }else if(msg.phase==='waiting'){
      currentMul=1.0;flyPts=[];
      if(msg.betCount)updatePlayerCount(msg.betCount);
      updateRing(msg.timeLeft||8);
      showScreen('wait');
    }else if(msg.phase==='flying'){
      currentMul=1.0;flyPts=[1.0];
      showScreen('fly');
      document.getElementById('multiplier-display').className='flying';
      document.getElementById('multiplier-display').textContent='1.00x';
      document.getElementById('status-text').textContent='';
      drawGraph();
    }else if(msg.phase==='crashed'){
      currentMul=msg.crashAt||currentMul;
      flyPts.push(currentMul);
      showScreen('crash');
      document.getElementById('multiplier-display').className='crashed';
      document.getElementById('multiplier-display').textContent=fmtM(currentMul);
      document.getElementById('crash-at-text').textContent='Nổ tại '+fmtM(currentMul);
      document.getElementById('status-text').textContent='Phiên kết thúc';
      if(msg.history)renderHistory(msg.history);
      drawGraph();
      if(myBet>0&&!myCashedOut)toast('💥 Thua '+fmtN(myBet),'#ef4444');
    }
    renderBtn();updateBetInfo();

  }else if(msg.type==='tick_wait'){
    curWait=msg.timeLeft;updateRing(msg.timeLeft);
    if(msg.betCount!=null)updatePlayerCount(msg.betCount);
    document.getElementById('wait-msg').textContent='Đặt cược trong '+Math.ceil(msg.timeLeft)+'s!';
    updateBetInfo();

  }else if(msg.type==='tick_fly'){
    currentMul=msg.multiplier;flyPts.push(msg.multiplier);drawGraph();
    document.getElementById('multiplier-display').textContent=fmtM(currentMul);
    if(myBet>0&&!myCashedOut)
      document.getElementById('action-btn').textContent='💸 RÚT '+fmtN(Math.floor(myBet*currentMul));
    updateBetInfo();

  }else if(msg.type==='bet_ok'){
    myBet=msg.amount;setBalance(msg.balance);
    toast('✅ Đặt '+fmtN(msg.amount)+' — Chờ cất cánh!','#10b981');
    renderBtn();updateBetInfo();

  }else if(msg.type==='cashout_ok'){
    myCashedOut=true;setBalance(msg.balance);
    toast('🎉 Rút x'+msg.multiplier.toFixed(2)+' = '+fmtN(msg.payout),'#10b981');
    document.getElementById('status-text').textContent='Rút tại '+fmtM(msg.multiplier)+' ✓';
    renderBtn();

  }else if(msg.type==='result'){
    if(typeof msg.balance==='number')setBalance(msg.balance);
    renderBtn();

  }else if(msg.type==='bet_count'){
    if(msg.betCount!=null)updatePlayerCount(msg.betCount);

  }else if(msg.type==='error'){
    toast('❌ '+msg.msg,'#ef4444');
  }
}

/* ── History bar ───────────────────────────── */
function renderHistory(hist){
  const bar=document.getElementById('history-bar');
  let html='<span style="font-size:11px;color:#4b5563;white-space:nowrap">Lịch sử:</span>';
  (hist||[]).forEach(h=>{
    const cls=h.crashAt<1.5?'low':h.crashAt<3?'mid':h.crashAt<10?'high':'ultra';
    html+='<div class="hist-chip '+cls+'">'+h.crashAt.toFixed(2)+'x</div>';
  });
  bar.innerHTML=html;
}

/* ── SSE connection ────────────────────────── */
function connect(){
  if(sse){try{sse.close()}catch{}}
  sse=new EventSource(API+'/crash-stream?tgid='+encodeURIComponent(tgId));
  sse.onmessage=e=>{try{handleMsg(JSON.parse(e.data))}catch{}};
  sse.onerror=()=>{sse.close();clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,2000)};
}

/* ── Action button ─────────────────────────── */
async function onAction(){
  if((phase==='idle'||phase==='waiting')&&myBet===0){
    const amount=parseInt(document.getElementById('bet-input').value);
    if(!amount||amount<1000){toast('Nhập số tiền tối thiểu 1.000đ','#f59e0b');return;}
    document.getElementById('action-btn').disabled=true;
    try{
      const r=await fetch(API+'/crash-bet?tgid='+encodeURIComponent(tgId)+'&amount='+amount,{method:'POST'});
      const d=await r.json();
      if(!d.ok){toast('❌ '+d.msg,'#ef4444');document.getElementById('action-btn').disabled=false;}
      // Show badge on idle screen
      document.getElementById('idle-bet-badge').style.display='block';
    }catch{toast('❌ Lỗi kết nối!','#ef4444');document.getElementById('action-btn').disabled=false;}
  }else if(phase==='flying'&&myBet>0&&!myCashedOut){
    document.getElementById('action-btn').disabled=true;
    try{
      const r=await fetch(API+'/crash-cashout?tgid='+encodeURIComponent(tgId),{method:'POST'});
      const d=await r.json();
      if(!d.ok){toast('❌ '+d.msg,'#ef4444');document.getElementById('action-btn').disabled=false;}
    }catch{toast('❌ Lỗi kết nối!','#ef4444');document.getElementById('action-btn').disabled=false;}
  }
}

// Balance refresh
setInterval(async()=>{
  try{const r=await fetch(API+'/crash-state?tgid='+encodeURIComponent(tgId));
  const d=await r.json();if(typeof d.balance==='number'&&!myBet)setBalance(d.balance);}catch{}
},30000);

showScreen('idle');
connect();
</script>
</body>
</html>`;

/* ─────────────────────────────────────────────────────────── */
/*  Routes                                                      */
/* ─────────────────────────────────────────────────────────── */

router.get("/games/may-bay", (_req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(MAY_BAY_HTML);
});

router.get("/games/crash-stream", async (req: Request, res: Response): Promise<void> => {
  const tgId = (req.query["tgid"] as string) || "";
  if (!tgId) { res.status(400).json({ error: "tgid required" }); return; }

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const user = await storage.getBotUser(tgId);
    const balance = user ? parseFloat(user.balance || "0") : 0;

    registerSSEClient(tgId, res);

    const state = getGameState();
    res.write(`data: ${JSON.stringify({ type: "init", ...state, balance })}\n\n`);

    if (!user) {
      res.write(`data: ${JSON.stringify({ type: "error", msg: "Tài khoản không tồn tại. Vui lòng /start bot trước!" })}\n\n`);
    }
  } catch {
    res.status(500).end();
  }
});

router.get("/games/crash-state", async (req: Request, res: Response): Promise<void> => {
  const tgId = (req.query["tgid"] as string) || "";
  try {
    const user = tgId ? await storage.getBotUser(tgId) : null;
    const balance = user ? parseFloat(user.balance || "0") : 0;
    res.json({ ...getGameState(), balance });
  } catch {
    res.status(500).json({ error: "server error" });
  }
});

router.post("/games/crash-bet", async (req: Request, res: Response): Promise<void> => {
  const tgId = (req.query["tgid"] as string) || (req.body?.tgid as string) || "";
  const amount = Number((req.query["amount"] as string) || req.body?.amount);
  if (!tgId) { res.status(400).json({ ok: false, msg: "tgid required" }); return; }
  if (!/^\d{5,15}$/.test(tgId)) { res.status(400).json({ ok: false, msg: "Invalid tgid" }); return; }
  if (!Number.isFinite(amount) || amount <= 0) { res.status(400).json({ ok: false, msg: "Amount must be a positive number" }); return; }
  const result = await handleBet(tgId, amount);
  res.json(result);
});

router.post("/games/crash-cashout", async (req: Request, res: Response): Promise<void> => {
  const tgId = (req.query["tgid"] as string) || (req.body?.tgid as string) || "";
  if (!tgId) { res.status(400).json({ ok: false, msg: "tgid required" }); return; }
  const result = await handleCashout(tgId);
  res.json(result);
});

export default router;
