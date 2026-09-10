const $ = (id) => document.getElementById(id);
let ws=null, state=null, me={};

// prefill code from ?code= or #code=
const params = new URLSearchParams(location.search);
const preset = (params.get("code") || location.hash.replace("#","")).toUpperCase();
if(preset) $("code").value = preset;

function uid(){ return Math.random().toString(36).slice(2,10); }

$("go").onclick = join;
$("code").addEventListener("keydown", e=>{ if(e.key==="Enter") join(); });
$("name").addEventListener("keydown", e=>{ if(e.key==="Enter") join(); });

async function join(){
  const code = $("code").value.trim().toUpperCase();
  const name = $("name").value.trim();
  if(code.length<4){ err("Enter the room code."); return; }
  if(!name){ err("Enter your name."); return; }
  const res = await fetch(`/api/sessions/${code}/exists`);
  const { exists } = await res.json();
  if(!exists){ err("No room with that code. Check with your teacher."); return; }

  // keep a stable id per room so a refresh re-attaches
  const key = "ww-sid-"+code;
  let sid = localStorage.getItem(key);
  if(!sid){ sid = uid(); localStorage.setItem(key, sid); }
  me = { code, name, sid };

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${code}?role=student&sid=${sid}&name=${encodeURIComponent(name)}`);
  ws.onmessage = (ev)=>{ const m = JSON.parse(ev.data);
    if(m.type==="error"){ err(m.message); ws.close(); return; }
    state = m; showPlay(); render();
  };
  ws.onclose = ()=>{ if(state) setStage(`<div class="badge">Disconnected — refresh to rejoin</div>`); };

  $("me").textContent = name;
  $("room").textContent = "Room "+code;
}
function err(m){ const e=$("join-err"); e.textContent=m; e.classList.remove("hidden"); }
function showPlay(){ $("join").classList.add("hidden"); $("play").classList.remove("hidden"); }
function setStage(html){ $("stage").innerHTML = html; }

function submit(){
  const inp = document.getElementById("ans");
  const word = (inp?.value || "").trim();
  if(!word) return;
  ws.send(JSON.stringify({type:"submit", word}));
}

function render(){
  if(!state) return;
  const p = state.phase;

  if(p==="lobby")  return setStage(`<div class="stack" style="align-items:center">
      <div class="badge">✓ You're in</div>
      <h2 class="prompt" style="font-size:clamp(24px,5vw,40px)">Waiting for your teacher…</h2>
      <div class="sub">Get ready to think.</div></div>`);

  if(p==="think")  return setStage(`<div class="stack" style="align-items:center">
      <div class="ring tnum" id="ring">–</div>
      <div class="badge">🔒 Answers locked — think first</div>
      <h2 class="prompt">${state.prompt}</h2>
      <div class="sub">What will your answer be?</div></div>`);

  if(p==="answer"){
    if(state.you && state.you.answered){
      return setStage(`<div class="stack" style="align-items:center">
        <div class="badge" style="background:rgba(18,191,160,.2);border-color:rgba(18,191,160,.5)">✓ Answer sent: <b>${state.you.word}</b></div>
        <div class="sub">Nice. Waiting for the others…</div></div>`);
    }
    return setStage(`<div class="stack" style="align-items:center;width:100%">
      <div class="ring tnum" id="ring">–</div>
      <h2 class="prompt" style="font-size:clamp(24px,4.5vw,38px)">${state.prompt}</h2>
      <input id="ans" class="answer-input" autofocus maxlength="40" placeholder="type one word…" onkeydown="if(event.key==='Enter')submit()">
      <button class="btn primary big full" style="width:min(520px,90vw)" onclick="submit()">Send answer</button></div>`);
  }

  if(p==="reveal"){
    let wallHtml = `<div class="sub">Look up at the board 👀</div>`;
    if(state.wall){
      wallHtml = `<div class="card" style="background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.14);width:min(760px,92vw)"><div class="wall">`+
        state.wall.map(g=>`<div class="tile" style="background:${colorForW(g.word)};font-size:${Math.min(15+(g.count-1)*4,30)}px">${g.word}${g.count>1?` ×${g.count}`:""}</div>`).join("")+
        `</div></div>`;
    }
    return setStage(`<div class="stack" style="align-items:center">
      <div class="badge" style="background:rgba(124,92,255,.2);border-color:rgba(124,92,255,.5)">Time's up</div>
      <h2 class="prompt" style="font-size:clamp(22px,4vw,32px)">${state.prompt}</h2>${wallHtml}</div>`);
  }

  if(p==="ended") return setStage(`<div class="stack" style="align-items:center">
      <div class="badge">Session ended</div>
      <h2 class="prompt">Thanks for playing!</h2>
      <a class="btn" href="/">Back to start</a></div>`);
}

const COLORS = ["#ff5d5d","#12bfa0","#7c5cff","#ffb020","#3b82f6","#ff64b4","#7bc74d","#00b3d6"];
function colorForW(s){ let h=0; for(const c of s||"") h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; }

// local countdown that reads the latest server phaseEndsAt
setInterval(()=>{
  const ring = document.getElementById("ring");
  if(ring && state && state.phaseEndsAt){
    ring.textContent = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now())/1000));
  }
}, 250);
