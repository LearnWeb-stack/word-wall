"""
Word Wall — Stage 1: FastAPI + WebSockets real-time core.

The server is the single source of truth for every room. Browsers are thin
clients: they connect over a WebSocket, receive the room's state whenever it
changes, and send small action messages (start round, submit answer, ...).

Key teaching points in this file:
  * REST endpoint to CREATE a session (returns a room code).
  * A WebSocket endpoint (/ws/{code}) that streams state to everyone in a room.
  * The SERVER drives the think -> answer -> reveal timer with an asyncio task,
    so the countdown can never get "stuck" if a browser tab is backgrounded.
  * Answers are only accepted while phase == "answer" — enforced on the server,
    so a student can't bypass the locked think phase by editing the page.

No database yet (state lives in memory) and no AI yet — those are Stages 2 & 3.
"""

from __future__ import annotations

import asyncio
import random
import string
import time
from dataclasses import dataclass, field
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

app = FastAPI(title="Word Wall")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no easily-confused chars


def gen_code(n: int = 4) -> str:
    return "".join(random.choice(CODE_ALPHABET) for _ in range(n))


def now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# Room model — all live state for one session
# ---------------------------------------------------------------------------

@dataclass
class Connection:
    ws: WebSocket
    role: str            # "teacher" or "student"
    sid: str             # student id (empty for teacher)


@dataclass
class Room:
    code: str
    questions: list[dict]                     # [{"prompt": str, "answer": str}]
    think_seconds: int
    answer_seconds: int
    show_wall: bool
    phase: str = "lobby"                       # lobby|think|answer|reveal|ended
    question_index: int = 0
    phase_ends_at: Optional[int] = None        # epoch ms, or None
    students: dict[str, str] = field(default_factory=dict)         # id -> name
    responses: dict[str, dict] = field(default_factory=dict)       # "qi:id" -> {name, word}
    connections: list[Connection] = field(default_factory=list)
    timer_task: Optional[asyncio.Task] = None

    # --- derived views -----------------------------------------------------
    def current_question(self) -> dict:
        return self.questions[self.question_index]

    def roster(self) -> list[dict]:
        """Every joined student + whether they've answered THIS question."""
        out = []
        for sid, name in self.students.items():
            r = self.responses.get(f"{self.question_index}:{sid}")
            out.append({"id": sid, "name": name,
                        "answered": r is not None,
                        "word": r["word"] if r else None})
        # answered first, then by name
        out.sort(key=lambda s: (not s["answered"], s["name"].lower()))
        return out

    def wall(self) -> list[dict]:
        """Aggregate answers for the current question (repeats grow)."""
        groups: dict[str, dict] = {}
        for key, r in self.responses.items():
            qi = int(key.split(":")[0])
            if qi != self.question_index:
                continue
            word = r["word"].strip()
            if not word:
                continue
            k = word.lower()
            g = groups.setdefault(k, {"word": word, "count": 0, "names": []})
            g["count"] += 1
            g["names"].append(r["name"])
        return sorted(groups.values(), key=lambda g: -g["count"])

    def state_for(self, role: str, sid: str = "") -> dict:
        q = self.current_question()
        base = {
            "type": "state",
            "code": self.code,
            "phase": self.phase,
            "questionIndex": self.question_index,
            "total": len(self.questions),
            "thinkSeconds": self.think_seconds,
            "answerSeconds": self.answer_seconds,
            "showWall": self.show_wall,
            "phaseEndsAt": self.phase_ends_at,
            "prompt": q["prompt"],
            "serverTime": now_ms(),
        }
        if role == "teacher":
            base["answer"] = q.get("answer", "")
            base["students"] = self.roster()
            base["answeredCount"] = sum(1 for s in self.roster() if s["answered"])
            base["wall"] = self.wall()
        else:  # student
            r = self.responses.get(f"{self.question_index}:{sid}")
            base["you"] = {"answered": r is not None, "word": r["word"] if r else None}
            # students only see the wall on reveal, and only if the teacher allows it
            base["wall"] = self.wall() if (self.phase == "reveal" and self.show_wall) else None
        return base


rooms: dict[str, Room] = {}


# ---------------------------------------------------------------------------
# Broadcasting + the server-driven phase timer
# ---------------------------------------------------------------------------

async def broadcast(room: Room) -> None:
    """Send each connection the view appropriate to its role. Drop dead sockets."""
    dead: list[Connection] = []
    for c in list(room.connections):
        try:
            await c.ws.send_json(room.state_for(c.role, c.sid))
        except Exception:
            dead.append(c)
    for c in dead:
        if c in room.connections:
            room.connections.remove(c)


def cancel_timer(room: Room) -> None:
    if room.timer_task and not room.timer_task.done():
        room.timer_task.cancel()
    room.timer_task = None


async def run_phase_timer(room: Room, seconds: int, next_phase: str) -> None:
    """Sleep, then advance the room to next_phase and (maybe) chain again."""
    try:
        await asyncio.sleep(seconds)
    except asyncio.CancelledError:
        return
    if next_phase == "answer":
        room.phase = "answer"
        room.phase_ends_at = now_ms() + room.answer_seconds * 1000
        room.timer_task = asyncio.create_task(
            run_phase_timer(room, room.answer_seconds, "reveal"))
    else:  # reveal
        room.phase = "reveal"
        room.phase_ends_at = None
        room.timer_task = None
    await broadcast(room)


def start_round(room: Room) -> None:
    cancel_timer(room)
    if room.think_seconds > 0:
        room.phase = "think"
        room.phase_ends_at = now_ms() + room.think_seconds * 1000
        room.timer_task = asyncio.create_task(
            run_phase_timer(room, room.think_seconds, "answer"))
    else:
        room.phase = "answer"
        room.phase_ends_at = now_ms() + room.answer_seconds * 1000
        room.timer_task = asyncio.create_task(
            run_phase_timer(room, room.answer_seconds, "reveal"))


# ---------------------------------------------------------------------------
# Page routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request, "home.html")


@app.get("/teacher", response_class=HTMLResponse)
async def teacher(request: Request):
    return templates.TemplateResponse(request, "teacher.html")


@app.get("/join", response_class=HTMLResponse)
async def join(request: Request):
    return templates.TemplateResponse(request, "student.html")


# ---------------------------------------------------------------------------
# REST: create a session / check a code
# ---------------------------------------------------------------------------

class SessionIn(BaseModel):
    questions: list[dict]
    thinkSeconds: int = 20
    answerSeconds: int = 30
    showWall: bool = True


@app.post("/api/sessions")
async def create_session(body: SessionIn):
    clean = [{"prompt": q.get("prompt", "").strip(), "answer": q.get("answer", "").strip()}
             for q in body.questions if q.get("prompt", "").strip()]
    if not clean:
        raise HTTPException(400, "Add at least one prompt")
    code = gen_code()
    while code in rooms:
        code = gen_code()
    rooms[code] = Room(
        code=code, questions=clean,
        think_seconds=max(0, body.thinkSeconds),
        answer_seconds=max(5, body.answerSeconds),
        show_wall=body.showWall,
    )
    return {"code": code}


@app.get("/api/sessions/{code}/exists")
async def session_exists(code: str):
    return {"exists": code.upper() in rooms}


# ---------------------------------------------------------------------------
# WebSocket: the live channel for a room
# ---------------------------------------------------------------------------

@app.websocket("/ws/{code}")
async def ws_endpoint(ws: WebSocket, code: str, role: str = "student",
                      sid: str = "", name: str = ""):
    code = code.upper()
    room = rooms.get(code)
    await ws.accept()
    if room is None:
        await ws.send_json({"type": "error", "message": "No room with that code."})
        await ws.close()
        return

    conn = Connection(ws=ws, role=role, sid=sid)
    room.connections.append(conn)

    # a student joining registers themselves in the roster
    if role == "student" and sid:
        room.students.setdefault(sid, name or "Guest")

    await broadcast(room)  # everyone (incl. the newcomer) gets fresh state

    try:
        while True:
            msg = await ws.receive_json()
            await handle_message(room, role, sid, msg)
    except WebSocketDisconnect:
        pass
    finally:
        if conn in room.connections:
            room.connections.remove(conn)
        # note: we keep the student in the roster if they drop, so a refresh
        # re-attaches to the same name/answers.


async def handle_message(room: Room, role: str, sid: str, msg: dict) -> None:
    t = msg.get("type")

    # ---- teacher actions ----
    if role == "teacher":
        if t == "start_round":
            start_round(room)
        elif t == "skip":                        # skip think -> open answers
            cancel_timer(room)
            room.phase = "answer"
            room.phase_ends_at = now_ms() + room.answer_seconds * 1000
            room.timer_task = asyncio.create_task(
                run_phase_timer(room, room.answer_seconds, "reveal"))
        elif t == "reveal":
            cancel_timer(room)
            room.phase = "reveal"
            room.phase_ends_at = None
        elif t == "next":
            cancel_timer(room)
            if room.question_index < len(room.questions) - 1:
                room.question_index += 1
                room.phase = "lobby"
                room.phase_ends_at = None
        elif t == "prev":
            cancel_timer(room)
            if room.question_index > 0:
                room.question_index -= 1
                room.phase = "lobby"
                room.phase_ends_at = None
        elif t == "toggle_wall":
            room.show_wall = not room.show_wall
        elif t == "end":
            cancel_timer(room)
            room.phase = "ended"
        await broadcast(room)
        return

    # ---- student actions ----
    if role == "student":
        if t == "submit":
            # server enforces the think-lock: answers only count during "answer"
            if room.phase != "answer":
                return
            word = (msg.get("word") or "").strip()[:40]
            if not word:
                return
            room.responses[f"{room.question_index}:{sid}"] = {
                "name": room.students.get(sid, "Guest"), "word": word,
            }
            await broadcast(room)
        return
