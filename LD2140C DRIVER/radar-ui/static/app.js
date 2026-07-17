(() => {
  const canvas = document.getElementById("radar");
  const ctx = canvas.getContext("2d");
  const presenceEl = document.getElementById("presence");
  const targetCountEl = document.getElementById("targetCount");
  const nearestEl = document.getElementById("nearest");
  const rangeEl = document.getElementById("range");
  const linkStatus = document.getElementById("linkStatus");

  let state = {
    present: false,
    target_count: 0,
    targets: [],
    max_range_mm: 6000,
    connected: false,
    port: null,
  };

  let sweepAngle = -Math.PI / 2;
  const displayedTargets = new Map();

  function setLinkStatus(ok, text) {
    linkStatus.textContent = text;
    linkStatus.classList.toggle("ok", ok);
    linkStatus.classList.toggle("bad", !ok);
  }

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      setLinkStatus(true, state.port ? `serial ${state.port}` : "connected");
    };

    ws.onmessage = (event) => {
      try {
        state = { ...state, ...JSON.parse(event.data) };
      } catch {
        return;
      }

      if (!state.connected) {
        setLinkStatus(false, "serial disconnected");
      } else {
        setLinkStatus(true, state.port ? `serial ${state.port}` : "live");
      }

      presenceEl.textContent = state.present ? "PERSON" : "clear";
      presenceEl.style.color = state.present ? "#ff3b4a" : "#3dffa8";
      targetCountEl.textContent = String(state.target_count || 0);
      const nearest = (state.targets || []).reduce((best, target) => {
        const distance = Math.hypot(target.x_mm, target.y_mm);
        return best === null || distance < best ? distance : best;
      }, null);
      nearestEl.textContent =
        nearest === null ? "—" : `${(nearest / 1000).toFixed(2)} m`;
      rangeEl.textContent = `${(state.max_range_mm / 1000).toFixed(1)} m`;
    };

    ws.onclose = () => {
      setLinkStatus(false, "reconnecting…");
      setTimeout(connect, 1000);
    };

    ws.onerror = () => ws.close();
  }

  function draw() {
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxRange = state.max_range_mm || 6000;
    const radius = Math.min(w, h) * 0.42;

    ctx.clearRect(0, 0, w, h);

    // Soft radar wash
    const wash = ctx.createRadialGradient(cx, cy, 10, cx, cy, radius * 1.2);
    wash.addColorStop(0, "rgba(47, 125, 255, 0.16)");
    wash.addColorStop(1, "rgba(47, 125, 255, 0)");
    ctx.fillStyle = wash;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.15, 0, Math.PI * 2);
    ctx.fill();

    // Range rings
    for (let i = 1; i <= 4; i++) {
      const r = (radius * i) / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(140, 180, 255, 0.18)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const meters = ((maxRange * i) / 4 / 1000).toFixed(1);
      ctx.fillStyle = "rgba(170, 190, 220, 0.7)";
      ctx.font = "14px Segoe UI, sans-serif";
      ctx.fillText(`${meters}m`, cx + 8, cy - r + 16);
    }

    // Outer blue detection circle
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(47, 125, 255, 0.08)";
    ctx.fill();
    ctx.strokeStyle = "#2f7dff";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Crosshairs / forward axis
    ctx.strokeStyle = "rgba(140, 180, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // Classic sweep arm
    sweepAngle += 0.03;
    const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    sweepGrad.addColorStop(0, "rgba(61, 255, 168, 0.28)");
    sweepGrad.addColorStop(1, "rgba(61, 255, 168, 0)");
    ctx.fillStyle = sweepGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, sweepAngle - 0.45, sweepAngle);
    ctx.closePath();
    ctx.fill();

    // Sensor at center
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = "#e8f1ff";
    ctx.fill();
    ctx.strokeStyle = "#2f7dff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Smooth and draw each real X/Y target. Positive Y is forward (up).
    const activeIds = new Set();
    for (const target of state.targets || []) {
      activeIds.add(target.id);
      const previous = displayedTargets.get(target.id) || {
        x: target.x_mm,
        y: target.y_mm,
      };
      previous.x += (target.x_mm - previous.x) * 0.28;
      previous.y += (target.y_mm - previous.y) * 0.28;
      displayedTargets.set(target.id, previous);

      const px = cx + (previous.x / maxRange) * radius;
      const py = cy - (previous.y / maxRange) * radius;

      // Ignore points outside the selected circular display range.
      if (Math.hypot(previous.x, previous.y) > maxRange * 1.1) continue;

      const glow = ctx.createRadialGradient(px, py, 0, px, py, 25);
      glow.addColorStop(0, "rgba(255, 59, 74, 0.55)");
      glow.addColorStop(1, "rgba(255, 59, 74, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(px, py, 25, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fillStyle = "#ff3b4a";
      ctx.fill();
      ctx.strokeStyle = "#ffd0d4";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#ffd0d4";
      ctx.font = "bold 14px Segoe UI, sans-serif";
      ctx.fillText(
        `T${target.id}  ${(target.x_mm / 1000).toFixed(2)}, ${(target.y_mm / 1000).toFixed(2)}m`,
        px + 14,
        py - 12,
      );
    }

    for (const id of displayedTargets.keys()) {
      if (!activeIds.has(id)) displayedTargets.delete(id);
    }

    requestAnimationFrame(draw);
  }

  connect();
  draw();
})();
