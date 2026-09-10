const $ = (id) => document.getElementById(id);
const COLORS = ["#ff5d5d","#12bfa0","#7c5cff","#ffb020","#3b82f6","#ff64b4","#7bc74d","#00b3d6"];
const colorFor = (s) => { let h=0; for(const c of s||"") h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; };
const initials = (n) => (n||"?").trim().split(/\s+/).map(p=>p[0]||"").slice(0,2).join("").toUpperCase();

let ws=null, state=null;

function parseQuestions(text){
  return text.split("\n").map(line=>{
    const [p,a] = line.split("|");
    return {prompt:(p||"").trim(), answer:(a||"").trim()};
  }).filter(q=>q.prompt);
}

$("create").onclick = async () => {
  const questions = parseQuestions($("questions").value);
  if(!questions.length){ showErr("Add at least one prompt."); return; }
  const body = { questions, thinkSeconds:+$("think").value||0, answerSeconds:+$("answer").value||30, showWall:$("showwall").checked };
  const res = await fetch("/api/sessions", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
  if(!res.ok){ showErr("Could not create session."); return; }
  const { code } = await res.json();
  openLive(code);
};
function showErr(m){ const e=$("setup-err"); e.textContent=m; e.classList.remove("hidden"); }

function openLive(code){
  $("setup").classList.add("hidden");
  $("live").classList.remove("hidden");
  $("code").textContent = code;
  const url = `${location.origin}/join`;
  $("origin").textContent = new URL(location.href).host + "/join";
  $("link").textContent = `Link: ${url}  (code ${code})`;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws/${code}?role=teacher`);
  ws.onmessage = (ev) => { state = JSON.parse(ev.data); render(); };
  ws.onclose = () => { $("phase").textContent = "disconnected"; };

  const send = (type) => ws && ws.readyState===1 && ws.send(JSON.stringify({type}));
  $("c-start").onclick  = () => send("start_round");
  $("c-skip").onclick   = () => send("skip");
  $("c-reveal").onclick = () => send("reveal");
  $("c-next").onclick   = () => send("next");
  $("c-prev").onclick   = () => send("prev");
  $("c-end").onclick    = () => { if(confirm("End this session?")) send("end"); };

  setInterval(tick, 250);  // local countdown refresh
}

const PHASE_LABEL = {lobby:"Ready",think:"Thinking",answer:"Answering",reveal:"Revealed",ended:"Ended"};

function render(){
  if(!state) return;
  $("phase").textContent = PHASE_LABEL[state.phase] || state.phase;
  $("joined").textContent = `${state.students.length} joined`;
  $("answered").textContent = `${state.answeredCount} answered`;
  $("ratio").textContent = `${state.answeredCount}/${state.students.length}`;
  $("qmeta").textContent = `Prompt ${state.questionIndex+1} of ${state.total}`;
  $("prompt").textContent = state.prompt;

  const exp = $("expected");
  if(state.answer){ exp.textContent = "Expected: "+state.answer; exp.classList.remove("hidden"); }
  else exp.classList.add("hidden");

  // controls
  $("c-start").classList.toggle("hidden", !(state.phase==="lobby"||state.phase==="reveal"));
  $("c-start").textContent = state.phase==="reveal" ? "Re-run this prompt ↻" : "Start round ▶";
  $("c-skip").classList.toggle("hidden", state.phase!=="think");
  $("c-reveal").classList.toggle("hidden", state.phase!=="answer");
  $("c-prev").disabled = state.questionIndex===0;
  $("c-next").disabled = state.questionIndex>=state.total-1;

  // wall
  const wall = $("wall");
  wall.innerHTML = "";
  (state.wall||[]).forEach(g=>{
    const size = Math.min(15+(g.count-1)*4, 30);
    const el = document.createElement("div");
    el.className = "tile"; el.style.background = colorFor(g.word); el.style.fontSize = size+"px";
    el.innerHTML = `${g.word}${g.count>1?` ×${g.count}`:""}<span class="who">${g.names.join(", ")}</span>`;
    wall.appendChild(el);
  });

  // roster
  const roster = $("roster");
  if(!state.students.length){ roster.innerHTML = '<div class="muted small">No students yet.</div>'; }
  else {
    roster.innerHTML = "";
    state.students.forEach(s=>{
      const el = document.createElement("div");
      el.className = "ri" + (s.answered?" answered":"");
      el.innerHTML = `<div class="avatar" style="background:${colorFor(s.name)}">${initials(s.name)}</div>
        <span style="font-weight:600">${s.name}</span>` +
        (s.answered ? `<span class="ans">${s.word}</span>` : `<span class="muted small" style="margin-left:auto">thinking…</span>`);
      roster.appendChild(el);
    });
  }
  tick();
}

function tick(){
  if(!state) return;
  const t = $("timer");
  if((state.phase==="think"||state.phase==="answer") && state.phaseEndsAt){
    const rem = Math.max(0, Math.ceil((state.phaseEndsAt - Date.now())/1000));
    t.textContent = rem+"s"; t.classList.remove("hidden");
  } else t.classList.add("hidden");
}
