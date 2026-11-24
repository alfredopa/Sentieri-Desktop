// ---------------------------------------------------------------------------
// Grafici del dialogo dettagli: altimetria, frequenza cardiaca, e-bike.
// app.js li usa con RouteCharts.render(contenitore, feature).
// I dati dei sensori arrivano da geojson.php in feature.metrics, allineati ai punti della traccia.
// ---------------------------------------------------------------------------
(function () {
  const W = 560, H = 160, padL = 46, padR = 12, padT = 10, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const MAX_DRAW_POINTS = 700;   // oltre questo numero si disegna un campione dei punti
  let lastView = "ele";          // il grafico scelto resta lo stesso aprendo altri percorsi

  const r = (v) => Math.round(v);

  function kmBetween(a, b) {     // distanza in km fra due punti [lon, lat] (Haversine)
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  // Serie valida solo se ha la lunghezza dei punti e almeno un valore diverso da vuoto e da 0
  function sensor(arr, n, isValid) {
    if (!Array.isArray(arr) || arr.length !== n) return null;
    const out = arr.map((v) => (Number.isFinite(v) && isValid(v) ? v : null));
    return out.some((v) => v !== null && v !== 0) ? out : null;
  }

  function stats(values) {
    let min = Infinity, max = -Infinity, sum = 0, count = 0, first = null, last = null;
    for (const v of values) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v; count++;
      if (first === null) first = v;
      last = v;
    }
    return { min, max, avg: count ? sum / count : 0, first, last };
  }

  function prepare(feature) {
    const coords = feature.geometry?.coordinates ?? [];
    const n = coords.length;
    const dist = new Array(n);
    let d = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) d += kmBetween(coords[i - 1], coords[i]);
      dist[i] = d;
    }
    const total = (n ? dist[n - 1] : 0) || 1;
    const m = feature.metrics || {};
    const views = [];

    const ele = coords.map((c) => (c.length >= 3 && Number.isFinite(c[2]) ? c[2] : null));
    if (ele.filter((v) => v !== null).length >= 2) {
      views.push({
        id: "ele", title: "Altimetria", multi: false,
        series: [{ name: "Quota", unit: "m", color: "#2f6b8e", values: ele, fill: true,
                   summary: (s) => `min ${r(s.min)} m · max ${r(s.max)} m` }]
      });
    }

    const hr = sensor(m.hr, n, (v) => v > 0);
    if (hr) {
      views.push({
        id: "hr", title: "Frequenza cardiaca", multi: false,
        series: [{ name: "FC", unit: "bpm", color: "#c94f4f", values: hr, fill: true,
                   summary: (s) => `media ${r(s.avg)} · max ${r(s.max)} bpm` }]
      });
    }

    const bat = sensor(m.battery, n, (v) => v >= 0 && v <= 100);
    const asl = sensor(m.assist, n, (v) => v >= 0);
    const pwr = sensor(m.power, n, (v) => v >= 0);
    const eb = [];
    if (bat) eb.push({ name: "Batteria", unit: "%", color: "#3a8f4b", values: bat, top: 100,
                       summary: (s) => `${r(s.first)} → ${r(s.last)} %` });
    if (asl) eb.push({ name: "Assistenza", unit: "", color: "#d98b1d", values: asl, step: true,
                       summary: (s) => `livelli ${r(s.min)}–${r(s.max)}` });
    if (pwr) eb.push({ name: "Potenza", unit: "W", color: "#7a52c7", values: pwr,
                       summary: (s) => `media ${r(s.avg)} · max ${r(s.max)} W` });
    if (eb.length) views.push({ id: "ebike", title: "E-bike", multi: true, series: eb });

    return { n, dist, total, views };
  }

  function stepPoints(seg) {     // linea a gradini, per valori discreti (livello di assistenza)
    const out = [seg[0]];
    for (let k = 1; k < seg.length; k++) out.push([seg[k][0], seg[k - 1][1]], seg[k]);
    return out;
  }

  const pts = (arr) => arr.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

  function plotSVG(view, data) {
    const { n, dist, total } = data;
    const stride = Math.max(1, Math.ceil(n / MAX_DRAW_POINTS));
    const idx = [];
    for (let i = 0; i < n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);

    const x = (d) => padL + (d / total) * plotW;
    const base = padT + plotH;
    let body = "";
    let labels = "";

    view.series.forEach((s) => {
      const st = stats(s.values);
      let lo, hi;
      if (view.multi) {                       // più serie: ognuna da 0 al proprio massimo
        lo = 0; hi = s.top ?? st.max;
        if (hi <= lo) hi = lo + 1;
      } else {
        lo = st.min; hi = st.max;
        if (hi - lo < 1e-9) { const f = s.unit === "m" ? 10 : 5; lo -= f; hi += f; }
        labels += `
      <text x="4" y="${padT + 4}" class="chart-label">${r(hi)} ${s.unit}</text>
      <text x="4" y="${padT + plotH / 2 + 4}" class="chart-label">${r((lo + hi) / 2)} ${s.unit}</text>
      <text x="4" y="${base}" class="chart-label">${r(lo)} ${s.unit}</text>`;
      }
      const y = (v) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

      const segs = [];
      let cur = [];
      for (const i of idx) {                  // i valori mancanti interrompono la linea
        const v = s.values[i];
        if (v === null) { if (cur.length) segs.push(cur); cur = []; }
        else cur.push([x(dist[i]), y(v)]);
      }
      if (cur.length) segs.push(cur);

      for (const seg of segs) {
        const line = s.step ? stepPoints(seg) : seg;
        if (s.fill && !view.multi && seg.length > 1) {
          const a = seg[0][0].toFixed(1), b = seg[seg.length - 1][0].toFixed(1);
          body += `<polygon points="${a},${base} ${pts(seg)} ${b},${base}" fill="${s.color}" fill-opacity="0.16" />`;
        }
        body += `<polyline points="${pts(line)}" fill="none" stroke="${s.color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" />`;
      }
    });

    const grid = view.multi
      ? [0.5, 1].map((f) => {
          const gy = (padT + plotH * (1 - f)).toFixed(1);
          return `<line x1="${padL}" y1="${gy}" x2="${padL + plotW}" y2="${gy}" class="chart-axis" opacity="0.25" />`;
        }).join("")
      : "";

    return `
    <svg viewBox="0 0 ${W} ${H}" class="rc-svg" role="img" aria-label="Grafico: ${view.title}" preserveAspectRatio="xMidYMid meet">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${base}" class="chart-axis" />
      <line x1="${padL}" y1="${base}" x2="${padL + plotW}" y2="${base}" class="chart-axis" />
      ${grid}${labels}
      <text x="${padL}" y="${H - 4}" class="chart-label">0 km</text>
      <text x="${padL + plotW}" y="${H - 4}" class="chart-label chart-label-end">${total.toFixed(1)} km</text>
      ${body}
      <line class="rc-cursor" x1="0" y1="${padT}" x2="0" y2="${base}" visibility="hidden" />
    </svg>`;
  }

  function legendHTML(view) {
    return view.series.map((s) =>
      `<span class="rc-chip"><span class="rc-dot" style="background:${s.color}"></span>` +
      `<strong>${s.name}</strong> ${s.summary(stats(s.values))}</span>`).join("");
  }

  function nearest(arr, target) {            // indice del punto più vicino alla distanza richiesta
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo > 0 && Math.abs(arr[lo - 1] - target) <= Math.abs(arr[lo] - target) ? lo - 1 : lo;
  }

  // Cursore e valori puntuali, con mouse o dito
  function attachPointer(plot, view, data) {
    const svg = plot.querySelector("svg");
    const tip = plot.querySelector(".rc-tip");
    const cursor = svg.querySelector(".rc-cursor");

    const hide = () => { tip.hidden = true; cursor.setAttribute("visibility", "hidden"); };
    const move = (e) => {
      const box = svg.getBoundingClientRect();
      if (!box.width) return;
      const px = ((e.clientX - box.left) / box.width) * W;
      const frac = Math.min(1, Math.max(0, (px - padL) / plotW));
      const i = nearest(data.dist, frac * data.total);
      const cx = padL + (data.dist[i] / data.total) * plotW;
      cursor.setAttribute("x1", cx);
      cursor.setAttribute("x2", cx);
      cursor.setAttribute("visibility", "visible");

      tip.innerHTML = `<strong>${data.dist[i].toFixed(2)} km</strong>` + view.series.map((s) => {
        const v = s.values[i];
        const txt = v === null ? "—" : `${r(v)}${s.unit ? " " + s.unit : ""}`;
        return `<span><span class="rc-dot" style="background:${s.color}"></span>${s.name}: ${txt}</span>`;
      }).join("");
      tip.hidden = false;

      const left = (cx / W) * box.width;
      let l = left + 12;
      if (l + tip.offsetWidth > plot.clientWidth) l = left - 12 - tip.offsetWidth;
      tip.style.left = Math.max(0, l) + "px";
    };

    plot.addEventListener("pointermove", move);
    plot.addEventListener("pointerdown", move);
    plot.addEventListener("pointerleave", hide);
    plot.addEventListener("pointercancel", hide);
  }

  function render(container, feature) {
    const data = prepare(feature);
    if (!data.views.length) {
      container.innerHTML = `<p class="chart-empty">Quota non disponibile per questo percorso.</p>`;
      return;
    }

    container.innerHTML = `<div class="rc-tabs" role="tablist" aria-label="Grafico da mostrare"></div>
      <div class="rc-plot"></div><div class="rc-legend"></div>`;
    const tabs = container.querySelector(".rc-tabs");
    const plot = container.querySelector(".rc-plot");
    const legend = container.querySelector(".rc-legend");
    tabs.hidden = data.views.length < 2;   // con un solo grafico non c'è nulla da scegliere

    const show = (view) => {
      lastView = view.id;
      tabs.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.view === view.id;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", String(on));
      });
      plot.innerHTML = plotSVG(view, data) + `<div class="rc-tip" hidden></div>`;
      legend.innerHTML = legendHTML(view);
      attachPointer(plot, view, data);
    };

    for (const v of data.views) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rc-tab";
      b.setAttribute("role", "tab");
      b.dataset.view = v.id;
      b.textContent = v.title;
      b.addEventListener("click", () => show(v));
      tabs.appendChild(b);
    }
    show(data.views.find((v) => v.id === lastView) || data.views[0]);
  }

  window.RouteCharts = { render };
})();
