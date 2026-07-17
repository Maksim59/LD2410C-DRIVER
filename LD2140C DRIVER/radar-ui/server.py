"""
Local LD2450 bird's-eye X/Y radar UI.

Reads Serial from the ESP32 DevKit (no Wi-Fi needed) and serves a radar page
in your browser at http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import asyncio
import json
import threading
import time
from pathlib import Path
from typing import Any

import serial
from serial.tools import list_ports
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import uvicorn

STATIC_DIR = Path(__file__).resolve().parent / "static"

latest: dict[str, Any] = {
    "sensor": "LD2450",
    "present": False,
    "target_count": 0,
    "max_range_mm": 6000,
    "uart_fresh": False,
    "targets": [],
    "connected": False,
    "port": None,
    "updated_at": 0.0,
}

clients: set[WebSocket] = set()
clients_lock = asyncio.Lock()
main_loop: asyncio.AbstractEventLoop | None = None


def find_esp32_port(preferred: str | None) -> str | None:
    if preferred:
        return preferred

    ports = list(list_ports.comports())
    keywords = (
        "cp210",
        "ch340",
        "ch910",
        "usb-serial",
        "usb serial",
        "silicon labs",
        "uart",
        "esp32",
        "wch",
    )
    for port in ports:
        blob = f"{port.device} {port.description} {port.manufacturer or ''}".lower()
        if any(k in blob for k in keywords):
            return port.device
    return ports[0].device if ports else None


async def broadcast(payload: dict[str, Any]) -> None:
    dead: list[WebSocket] = []
    async with clients_lock:
        targets = list(clients)
    text = json.dumps(payload)
    for ws in targets:
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    if dead:
        async with clients_lock:
            for ws in dead:
                clients.discard(ws)


def serial_worker(port: str, baud: int) -> None:
    global latest

    frame_count = 0
    last_report = time.time()

    while True:
        try:
            print(f"[serial] opening {port} @ {baud}")
            with serial.Serial(port, baud, timeout=1) as ser:
                print(f"[serial] OPEN OK on {port}. Waiting for RADAR: lines...")
                latest = {**latest, "connected": True, "port": port}
                if main_loop is not None:
                    asyncio.run_coroutine_threadsafe(broadcast(latest), main_loop)

                while True:
                    raw = ser.readline()

                    # Heartbeat so you can see the pipe is alive even with no targets.
                    now = time.time()
                    if now - last_report >= 3:
                        print(
                            f"[serial] {frame_count} RADAR frames so far | "
                            f"last targets={len(latest.get('targets') or [])}"
                        )
                        last_report = now

                    if not raw:
                        continue
                    try:
                        line = raw.decode("utf-8", errors="ignore").strip()
                    except Exception:
                        continue

                    if not line.startswith("RADAR:"):
                        if line:
                            print(f"[esp32] {line}")
                        continue

                    try:
                        data = json.loads(line[len("RADAR:") :])
                    except json.JSONDecodeError:
                        print(f"[serial] bad JSON: {line}")
                        continue

                    frame_count += 1
                    if frame_count == 1:
                        print(f"[serial] FIRST RADAR frame received: {data}")

                    latest = {
                        **latest,
                        **data,
                        "connected": True,
                        "port": port,
                        "updated_at": time.time(),
                    }
                    if main_loop is not None:
                        asyncio.run_coroutine_threadsafe(broadcast(latest), main_loop)
        except serial.SerialException as exc:
            print(f"[serial] disconnected: {exc}")
            latest = {
                **latest,
                "connected": False,
                "present": False,
                "target_count": 0,
                "targets": [],
            }
            if main_loop is not None:
                asyncio.run_coroutine_threadsafe(broadcast(latest), main_loop)
            time.sleep(2)
        except Exception as exc:
            print(f"[serial] error: {exc}")
            time.sleep(2)


app = FastAPI(title="LD2450 X/Y Radar")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
async def on_startup() -> None:
    global main_loop
    main_loop = asyncio.get_running_loop()


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/state")
async def api_state() -> dict[str, Any]:
    return latest


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    async with clients_lock:
        clients.add(websocket)
    try:
        await websocket.send_text(json.dumps(latest))
        while True:
            # Keep the socket open; updates are pushed from the serial thread.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        async with clients_lock:
            clients.discard(websocket)


def main() -> None:
    parser = argparse.ArgumentParser(description="LD2450 local X/Y radar UI")
    parser.add_argument("--port", help="Serial port, e.g. COM5 (auto-detect if omitted)")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--http-port", type=int, default=8765)
    args = parser.parse_args()

    available = list(list_ports.comports())
    print("Available serial ports:")
    if available:
        for p in available:
            print(f"  - {p.device}  ({p.description})")
    else:
        print("  (none detected)")

    serial_port = find_esp32_port(args.port)
    if not serial_port:
        raise SystemExit(
            "No serial port found. Plug in the ESP32 and retry, or pass --port COM5"
        )

    print(f"\nUsing serial: {serial_port} @ {args.baud}")
    print(f"Open in browser: http://{args.host}:{args.http_port}")
    print("If this is the wrong port, stop and rerun with --port COMx\n")

    thread = threading.Thread(
        target=serial_worker, args=(serial_port, args.baud), daemon=True
    )
    thread.start()

    uvicorn.run(app, host=args.host, port=args.http_port, log_level="info")


if __name__ == "__main__":
    main()
