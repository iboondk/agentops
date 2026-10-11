# Demo script: recording a GIF or Loom

This script shows AgentOps end to end in about 60 to 90 seconds: submit a task, watch it run
through the queue, then open the trace. Everything runs offline with the mock provider, so no
API key or network access is needed.

## Before you record

1. Use a clean terminal with a large font (16 pt or more) and a dark theme.
2. Start from a clean state so the trace list is short:
   ```bash
   rm -rf data/traces && mkdir -p data/traces
   ```
3. Pick one path and run its setup once, off camera.
   - **Path A (Docker Compose, full stack):** requires Docker with the Compose plugin.
     ```bash
     cp .env.example .env      # optional, defaults run offline
     docker compose up --build
     ```
   - **Path B (Node only, no Docker or Redis):** requires Node.js 20 or newer.
     ```bash
     npm ci
     npm run api               # API on :3000, in-process worker, in-memory queue
     npm run ui                # trace UI on :4318 (run in a second terminal)
     ```
4. Set the recorder to capture a 1280x800 region that includes the terminal and a browser window.
5. Close notifications and any window that shows real keys or paths you do not want public.

## Scene 1: the project (0:00 to 0:10)

- Show the README title and the architecture diagram.
- Narration: "AgentOps is a small agent runtime. It has tools, retries, timeouts, cost budgets,
  a job queue and traces. It runs offline by default."

## Scene 2: start the stack (0:10 to 0:25)

- Path A: show `docker compose up --build` and wait until the `api`, `worker` and `ui` lines are
  running. Say that Redis is the queue between them.
- Path B: show `npm run api` and `npm run ui`. Say that the in-memory queue runs an in-process
  worker, so Redis is not needed.
- Optional: show the health check.
  ```bash
  curl -s http://localhost:3000/healthz
  # {"ok":true}
  ```

## Scene 3: submit a task (0:25 to 0:45)

- Run the calculator example from the README:
  ```bash
  curl -s -X POST http://localhost:3000/tasks \
    -H 'Content-Type: application/json' \
    -d '{"input":"calculate (2+3)*4"}'
  # {"id":"<uuid>"}   HTTP 202
  ```
- Copy the id and poll it. Show the state move from `queued` or `running` to `done`:
  ```bash
  curl -s http://localhost:3000/tasks/<uuid>
  # {"id":"<uuid>","state":"done","result":{"status":"ok","output":"Answer: 20",...}}
  ```
- Narration: "The API returns 202 right away. The worker runs the agent, and the calculator tool
  does the arithmetic with its own parser, not `eval`."

## Scene 4: the trace (0:45 to 1:10)

- Open `http://localhost:4318/ui` in the browser.
- Select the newest trace. Point at the span waterfall: `agent.run` at the top, then `llm.call`
  and `tool.calculator` as children.
- Point at the token and cost attributes on the `llm.call` spans.
- Narration: "Every model call and tool call is a span, written to a JSONL file. The UI reads
  those files. Nothing leaves the machine unless OTLP export is turned on."

## Scene 5: optional, the eval report (1:10 to 1:20)

- Show `npm run eval` finishing, then open `reports/cost-per-task.md`.
- Say that the prices are illustrative placeholders for the mock provider. The report says so.

## Closing card (1:20 to 1:30)

- Show the README badge line and the repository URL. Do not show real keys or `.env` contents.

## After recording

- Trim dead time at the start and the end of each scene.
- For a GIF, export at 10 to 15 fps, under 10 MB, and keep the width at 1000 px or less.
- For a Loom, keep it under 2 minutes and turn on the camera only if you want it.
- Do not add real API keys, personal paths or account names to the recording. `.env` should hold
  no real values during the demo.
