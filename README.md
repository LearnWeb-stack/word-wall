# Word Wall — Python (FastAPI + WebSockets)

Stage 1 of the Python rebuild: the **real-time core**. A teacher posts prompts, a
locked think-timer runs, then students answer live from their own devices and a wall of
words builds — all synced over WebSockets by a FastAPI server.

This is a clean teaching artifact: the **server is the single source of truth**, browsers
are thin clients, and the think→answer→reveal timer is driven by the server (so a
backgrounded tab can never leave a student stuck).

## What's here

```
main.py              FastAPI app: REST to create a session, WebSocket for live sync,
                     server-driven phase timer, in-memory room state.
templates/           home / teacher / student pages (Jinja2).
static/              style.css, teacher.js, student.js (thin WebSocket clients).
requirements.txt
```

No database and no AI yet — those are Stage 2 (MongoDB) and Stage 3 (Anthropic).

## Run it locally

```bash
cd word-wall-py
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

Open http://127.0.0.1:8000

- **Teacher:** click "I'm the teacher", edit prompts (one per line; `prompt | expected answer`),
  set think/answer seconds, "Start session" → a room code appears.
- **Students:** open the same URL on other devices, "I'm a student", enter the code + a name.
- Drive the round from the teacher screen; watch "who answered" and the wall fill in.

To try it solo, open a second browser tab as a student — this uses real WebSockets, so it
also works across phones/laptops on the same network (point them at your computer's LAN IP,
e.g. `http://192.168.1.20:8000`).

## How it works (the parts worth understanding)

- **Create → REST.** `POST /api/sessions` validates the prompts and returns a room code.
  Session creation is a plain request/response, so it's a normal REST endpoint.
- **Live → WebSocket.** Everyone in a room connects to `ws://…/ws/{code}`. Whenever the
  room changes, the server pushes each client a *role-appropriate* view (the teacher sees
  every answer; students only see the wall on reveal).
- **The think-lock is server-enforced.** A student's answer is only stored while
  `phase == "answer"`. The locked think phase can't be bypassed by editing the page,
  because the server — not the browser — decides what counts.
- **The timer lives on the server.** Starting a round schedules an `asyncio` task that
  sleeps, flips think→answer, then answer→reveal, broadcasting at each step. No client
  drives it, so nothing gets stuck.

## Notes / limits (addressed in later stages)

- State is **in memory**, so restarting the server clears active rooms. Stage 2 adds
  MongoDB for persistence and a participation report.
- One server instance handles a class comfortably. Scaling to multiple instances would
  need shared state (e.g. Redis/Mongo change streams) — not needed for a classroom.
- Deployment (Stage 4): this is a running server, so host it on Render / Railway / Fly.io
  rather than static hosting.

## Next stages
2. **MongoDB Atlas** — persist sessions/responses; participation/engagement report.
3. **Anthropic AI** — open-response prior-knowledge feedback + class summary (the key
   stays server-side; no separate proxy needed because FastAPI *is* the server).
4. **Deploy + guardrails** — hosting, spending caps, rate limits, error handling.
