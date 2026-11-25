(() => {
  "use strict";
  const M = window.EXPLORER;
  const $ = (s) => document.querySelector(s);
  const CUTS = ["cut1", "cut128", "cut192"];
  const W = 257;                          // slice and texture width in voxels (u = -128..128)
  const VOX_UM = 7.91;
  const DEFAULT_REGION = "external_06";   // ranks 8th of 16 by area gained at cutoff 128
  const byId = Object.fromEntries(M.regions.map((r) => [r.id, r]));
  const C = {                              // drawing colors; data hues match the validated palette
    bone: "#efe9dc", bone3: "rgba(239, 233, 220, 0.55)", rule: "rgba(239, 233, 220, 0.22)",
    char: "#151311", char2: "#211e1a", halo: "rgba(8, 9, 12, 0.72)", tiled: "#5598e7", stock: "#f3efe6",
  };

  const state = {
    region: DEFAULT_REGION, cut: "cut128", v: 0,
    labels: true, stock: true, tiled: true,
    texMode: "swipe", swipe: 0.5, texColor: false, blinkOn: false,
    sortById: false, playing: false,
  };

  // ------------------------------------------------------------ URL hash  (#external_06/128/0)
  function readHash() {
    const [id, cut, v] = decodeURIComponent(location.hash.slice(1)).split("/");
    if (byId[id]) state.region = id;
    if (CUTS.includes("cut" + cut)) state.cut = "cut" + cut;
    const n = Number(v);
    if (v !== undefined && Number.isFinite(n) && n >= -128 && n <= 128) state.v = Math.round(n / 4) * 4;
  }
  function writeHash() {
    const h = `#${state.region}/${state.cut.slice(3)}/${state.v}`;
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  // ------------------------------------------------------------ loading
  const cache = new Map();
  const pending = new Map();
  window.__explorerRegion = (d) => { const done = pending.get(d.id); if (done) { pending.delete(d.id); done(d); } };
  const loadScript = (id) => new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const s = document.createElement("script");
    s.src = `data/${id}/traces.js`;
    s.onerror = () => reject(new Error(s.src));
    document.head.appendChild(s);
  });
  const loadImg = (src) => new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(src));
    im.src = src;
  });
  const IMAGES = ["ct.webp", "labels.png", "tex_ref.webp",
    ...CUTS.flatMap((c) => [`diff_${c}.png`, ...["stock", "tiled"].flatMap((m) => [`chart_${c}_${m}.png`, `tex_${c}_${m}.webp`])])];
  function loadRegion(id) {
    if (!cache.has(id)) {
      const p = Promise.all([loadScript(id), ...IMAGES.map((n) => loadImg(`data/${id}/${n}`))])
        .then(([t, ...ims]) => ({ id, t, img: Object.fromEntries(IMAGES.map((n, i) => [n, ims[i]])) }));
      p.catch(() => cache.delete(id));
      cache.set(id, p);
    }
    return cache.get(id);
  }

  let R = null;
  async function selectRegion(id) {
    state.region = id;
    markCurrent();
    renderMeta();
    writeHash();
    const load = $("#loading");
    load.textContent = "Loading region";
    load.classList.add("on");
    try {
      const r = await loadRegion(id);
      if (state.region !== id) return;
      R = r;
      load.classList.remove("on");
      drawAll();
      prefetchNeighbors();
    } catch (err) {
      load.textContent = "Could not load this region. Serve the docs folder over HTTP (python -m http.server) or use the published page.";
    }
  }
  function prefetchNeighbors() {
    const order = sortedRows().map((o) => o.r.id);
    const k = order.indexOf(state.region);
    const go = () => [order[k + 1], order[k - 1]].filter(Boolean).forEach((id) => loadRegion(id).catch(() => {}));
    ("requestIdleCallback" in window) ? requestIdleCallback(go, { timeout: 1500 }) : setTimeout(go, 400);
  }

  // ------------------------------------------------------------ text
  const f2 = (x) => x.toFixed(2);
  const f3 = (x) => x.toFixed(3);
  const signed = (x, f = f2) => (x > 0 ? "+" : x < 0 ? "−" : "±") + f(Math.abs(x));
  const pct = (a, b) => (a > 0 ? `${signed(100 * (b - a) / a, (x) => x.toFixed(1))}%` : "—");
  const mm = (vox) => (vox * VOX_UM / 1000);

  function renderSummary() {
    const p = M.pooled[state.cut].r128;
    const c = M.cutoffs[state.cut];
    $("#summary").innerHTML = `
      <div><dt class="micro">Target sheet found · cutoff ${c}</dt>
        <dd><span class="val blue">+${p.gain_percent.toFixed(1)}%</span>
        <span class="sub">${f2(p.stock_mm2)} → ${f2(p.tiled_mm2)}&nbsp;mm² across all 16 regions, within 1&nbsp;mm of the seed.</span></dd></div>
      <div><dt class="micro">Regions improved</dt>
        <dd><span class="val">${p.better}<span class="arrow">/</span>16</span>
        <span class="sub">${p.tie} tied and none got worse. The same holds at every cutoff.</span></dd></div>
      <div><dt class="micro">Mesh off the target sheet</dt>
        <dd><span class="val">${p.off_target_stock.toFixed(1)}<span class="arrow">→</span>${p.off_target_tiled.toFixed(1)}%</span>
        <span class="sub">Of the scored surface, the part not on the target sheet: on another sheet, unlabeled, or folded.</span></dd></div>
      <div><dt class="micro">A whole real mesh</dt>
        <dd><span class="val">2<span class="arrow">&thinsp;</span>min</span>
        <span class="sub">A full official GrowPatch mesh from PHerc. 125 on 20 CPU workers; the 41% inside its prediction cube is refined. A rerun matches byte for byte.</span></dd></div>`;
    const where = c === 192
      ? "The extra comes from surface that sat on unlabeled voxels and was pulled onto a neighbouring sheet."
      : "Most of the extra wrong-sheet area is in one region, external_10, where GrowPatch never connects the target sheet to the seed.";
    $("#caveat").innerHTML =
      `<span class="micro">Trade-off</span> The blend also lands some surface on neighbouring sheets. Of the surface that lands on any labeled sheet, ` +
      `the part on a wrong sheet goes from ${p.other_share_stock.toFixed(2)}% to ${p.other_share_tiled.toFixed(2)}% at cutoff ${c}, so it does not meet ` +
      `the strict no-increase check we set in advance. Almost nothing already on the right sheet is moved off it. ${where} <a href="#notes">More below</a>.`;
    $("#cutNote").textContent =
      `Cutoff is the threshold GrowPatch applies to the surface prediction; higher cutoffs leave it less surface to follow. ` +
      `The blend uses tiles every ${M.lock.spacing_vox} voxels. We picked that setting on 16 older labeled regions, then ran the blend once on these 16. ` +
      `These regions had been scored once before, for an earlier single-seed version of the blend.`;
    if (bandR) drawBand();
  }

  // ------------------------------------------------------------ the live scan band in the header
  const BAND_REGION = "external_06";
  const BAND_SWEEP = 64;   // voxels either side of the seed, where both surfaces stay in the strip
  let bandR = null, bandK = 32, bandDir = 1, bandTimer = null, bandVisible = true;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function drawBand() {
    const cv = $("#band");
    const cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !bandR) return;
    const ctx = fit(cv, cw, ch, false);
    const t = bandR.t, H = t.height, s = cw / W;
    const dy = ch / 2 - (t.wmax + 0.5) * s;      // keep the seed's depth on the band's centre line
    ctx.fillStyle = C.char; ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bandR.img["ct.webp"], 0, bandK * H, W, H, 0, dy, W * s, H * s);
    ctx.globalAlpha = 0.7;
    ctx.drawImage(bandR.img["labels.png"], 0, bandK * H, W, H, 0, dy, W * s, H * s);
    ctx.globalAlpha = 1;
    const tr = bandR.t.traces[state.cut];
    ctx.save(); ctx.translate(0, dy);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    polyPath(ctx, tr.tiled[bandK], s);
    ctx.strokeStyle = C.halo; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = C.tiled; ctx.lineWidth = 1.8; ctx.stroke();
    polyPath(ctx, tr.stock[bandK], s);
    ctx.strokeStyle = C.stock; ctx.lineWidth = 1.1; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    const g = ctx.createLinearGradient(0, 0, 0, ch);        // quiet top and bottom edges
    g.addColorStop(0, "rgba(21, 19, 17, 0.55)"); g.addColorStop(0.18, "rgba(21, 19, 17, 0)");
    g.addColorStop(0.82, "rgba(21, 19, 17, 0)"); g.addColorStop(1, "rgba(21, 19, 17, 0.55)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, cw, ch);
    const v = t.slices[bandK];
    $("#bandPos").textContent = v === 0 ? "Through the seed" : `${mm(Math.abs(v)).toFixed(2)} mm ${v > 0 ? "ahead of" : "behind"} the seed`;
  }
  function startBand() {
    if (bandTimer || reduceMotion || !bandR) return;
    bandTimer = setInterval(() => {
      const lo = bandR.t.slices.indexOf(-BAND_SWEEP), hi = bandR.t.slices.indexOf(BAND_SWEEP);
      if (bandK + bandDir < lo || bandK + bandDir > hi) bandDir *= -1;
      bandK += bandDir;
      drawBand();
    }, 150);
  }
  function stopBand() { clearInterval(bandTimer); bandTimer = null; }
  async function initBand() {
    try { bandR = await loadRegion(BAND_REGION); } catch (err) { return; }
    bandK = bandR.t.slices.indexOf(0);
    drawBand();
    startBand();
    new IntersectionObserver((es) => { bandVisible = es[0].isIntersecting; bandVisible ? startBand() : stopBand(); }).observe($("#band"));
    document.addEventListener("visibilitychange", () => (document.hidden ? stopBand() : bandVisible && startBand()));
    $("#band").addEventListener("click", () => {
      state.v = bandR.t.slices[bandK];
      selectRegion(BAND_REGION);
      document.querySelector(".stage").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    });
  }

  function sortedRows() {
    const rows = M.regions.map((r) => {
      const s = r.scores[state.cut];
      return { r, s, gain: s.tiled.r128 - s.stock.r128, dOther: s.tiled.other - s.stock.other };
    });
    rows.sort(state.sortById ? (a, b) => a.r.id.localeCompare(b.r.id)
      : (a, b) => b.gain - a.gain || a.r.id.localeCompare(b.r.id));
    return rows;
  }

  let firstList = true;
  function buildList() {
    const rows = sortedRows();
    const maxGain = Math.max(...rows.map((o) => o.gain), 1e-9);
    const ol = $("#regionList");
    ol.classList.toggle("intro", firstList);
    ol.innerHTML = "";
    rows.forEach((o, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.id = o.r.id;
      b.style.setProperty("--i", i);
      const flag = o.dOther > 0.01;
      b.setAttribute("aria-label", `${o.r.id}: target sheet ${f2(o.s.stock.r128)} to ${f2(o.s.tiled.r128)} square millimetres` +
        (flag ? `; wrong-sheet area up ${f3(o.dOther)} square millimetres` : ""));
      b.innerHTML = `
        <span class="disc-img"><img src="data/${o.r.id}/diff_${state.cut}.png" alt="" loading="lazy" width="129" height="129"></span>
        <span class="bar-slot"><i style="height:${Math.max(1, Math.round(28 * o.gain / maxGain))}px"></i></span>
        <span class="lab"><span class="num">${o.r.id.slice(-2)}</span>
          <span class="gain">${signed(o.gain)}${flag ? '<span class="diamond" title="Wrong-sheet area rose by more than 0.01 mm²"></span>' : ""}</span></span>`;
      b.addEventListener("click", () => { setPlaying(false); selectRegion(o.r.id); });
      li.appendChild(b);
      ol.appendChild(li);
    });
    if (firstList) { firstList = false; setTimeout(() => ol.classList.remove("intro"), 1400); }
    markCurrent();
  }
  function markCurrent() {
    const ol = $("#regionList");
    ol.querySelectorAll("button").forEach((b) => {
      if (b.dataset.id === state.region) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    });
    const cur = ol.querySelector('[aria-current="true"]');
    if (cur && ol.scrollWidth > ol.clientWidth) {
      const li = cur.parentElement;
      ol.scrollLeft = Math.max(0, li.offsetLeft - ol.clientWidth / 2 + li.clientWidth / 2);
    }
  }

  function renderMeta() {
    const r = byId[state.region];
    $("#regionNum").textContent = r.id.slice(-2);
    $("#regionTitle").textContent = r.id;
    $("#regionMeta").textContent = `Label cube ${r.cube}. Seed at x, y, z = ${r.seed_xyz.map((v) => Math.round(v)).join(", ")}. The target sheet is label ${r.target_id}.`;
    const s = r.scores[state.cut];
    const row = (name, a, b, opts = {}) => {
      const d = b - a;
      const f = opts.f || f2;
      const cls = opts.bad ? (d > 0.0005 ? "bad" : "") : (d > 0.0005 ? "up" : "");
      return `<tr><th scope="row">${name}</th><td class="stock">${f(a)}</td><td>${f(b)}</td>` +
        `<td class="change ${cls}">${signed(d, f)}${opts.pct ? `<small>${pct(a, b)}</small>` : ""}</td></tr>`;
    };
    $("#numbers").innerHTML = `
      <caption class="micro">${r.id} at cutoff ${M.cutoffs[state.cut]} · area in mm²</caption>
      <thead><tr><th></th><th scope="col">Official GrowPatch</th><th scope="col">Tiled blend</th><th scope="col">Change</th></tr></thead>
      <tbody>
        ${row("On the target sheet, within 128 voxels of the seed", s.stock.r128, s.tiled.r128, { pct: true })}
        ${row("Within 96 voxels", s.stock.r96, s.tiled.r96, { pct: true })}
        ${row("Between 96 and 128 voxels", s.stock.ring, s.tiled.ring, { pct: true })}
        ${row("On a wrong sheet, within 128 voxels", s.stock.other, s.tiled.other, { bad: true, f: f3 })}
      </tbody>
      <tfoot><tr><td colspan="4">The mesh was split into ${s.tiles} tiles. ${s.tiles_solved} found a surface ridge nearby and could shift the mesh; the other ${s.tiles - s.tiles_solved} found none and added nothing. Of the points that moved, 95 in 100 shifted less than ${s.move_p95} voxels, and half shifted less than ${s.move_median}. One voxel is ${VOX_UM}&nbsp;µm. "Target sheet" counts only surface joined to the seed.</td></tr></tfoot>`;
  }

  // ------------------------------------------------------------ canvas helpers
  function fit(cv, cssW, cssH, setStyle = true) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (setStyle) { cv.style.width = cssW + "px"; cv.style.height = cssH + "px"; }
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  function polyPath(ctx, polys, s) {
    ctx.beginPath();
    for (const p of polys) {
      ctx.moveTo((p[0] / 10 + 0.5) * s, (p[1] / 10 + 0.5) * s);
      for (let j = 2; j < p.length; j += 2) ctx.lineTo((p[j] / 10 + 0.5) * s, (p[j + 1] / 10 + 0.5) * s);
    }
  }
  const FONT = (px, w = 500, stretch = "normal") => `${stretch} ${w} ${px}px Archivo, "Arial Narrow", sans-serif`;

  // ------------------------------------------------------------ the slice
  const PAD = { l: 46, r: 8, t: 6, b: 34 };
  let geom = null;
  function paintSection(ctx, s, iw, ih, k) {
    const t = R.t, H = t.height, idx = t.slices.indexOf(state.v);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(R.img["ct.webp"], 0, idx * H, W, H, 0, 0, W * s, H * s);
    if (state.labels) ctx.drawImage(R.img["labels.png"], 0, idx * H, W, H, 0, 0, W * s, H * s);
    const half = Math.sqrt(Math.max(0, 128 * 128 - state.v * state.v));
    const xl = (128 - half + 0.5) * s, xr = (128 + half + 0.5) * s;
    ctx.fillStyle = "rgba(14, 12, 10, 0.66)";
    ctx.fillRect(0, 0, xl, ih);
    ctx.fillRect(xr, 0, iw - xr, ih);
    ctx.strokeStyle = C.rule; ctx.lineWidth = k; ctx.setLineDash([2 * k, 4 * k]);
    for (const x of [xl, xr]) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ih); ctx.stroke(); }
    ctx.setLineDash([]);
    const tr = t.traces[state.cut];
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    if (state.tiled) {
      polyPath(ctx, tr.tiled[idx], s);
      ctx.strokeStyle = C.halo; ctx.lineWidth = 5 * k; ctx.stroke();
      ctx.strokeStyle = C.tiled; ctx.lineWidth = 2.4 * k; ctx.stroke();
    }
    if (state.stock) {
      polyPath(ctx, tr.stock[idx], s);
      if (!state.tiled) { ctx.strokeStyle = C.halo; ctx.lineWidth = 4 * k; ctx.stroke(); }
      ctx.strokeStyle = C.stock; ctx.lineWidth = 1.5 * k; ctx.setLineDash([5 * k, 4 * k]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (state.v === 0) {
      ctx.strokeStyle = "rgba(243, 239, 230, 0.85)"; ctx.lineWidth = 1.2 * k;
      ctx.beginPath(); ctx.arc(128.5 * s, (t.wmax + 0.5) * s, 12 * s, 0, Math.PI * 2); ctx.stroke();
    }
  }

  function rulers(ctx, g) {
    const t = R.t;
    ctx.save();
    ctx.strokeStyle = C.bone3; ctx.fillStyle = C.bone3; ctx.lineWidth = 1;
    ctx.font = FONT(10.5, 500, "normal");
    // Along the sheet (u), bottom.
    const y0 = g.T + g.ih + 0.5;
    ctx.beginPath(); ctx.moveTo(g.L, y0); ctx.lineTo(g.L + g.iw, y0); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let m10 = -10; m10 <= 10; m10++) {
      const u = (m10 / 10) * 1000 / VOX_UM;
      if (Math.abs(u) > 128.5) continue;
      const x = g.L + (u + 128.5) * g.s;
      const major = m10 % 5 === 0;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + (major ? 7 : 3.5)); ctx.stroke();
      if (major) ctx.fillText(m10 === 0 ? "0" : (m10 / 10).toFixed(1).replace("-", "−"), x, y0 + 10);
    }
    ctx.textAlign = "right";
    ctx.fillText("mm along the sheet", g.L + g.iw, y0 + 22);
    // Across the sheets (w), left. 0 is the seed's depth.
    const x0 = g.L - 0.5;
    ctx.beginPath(); ctx.moveTo(x0, g.T); ctx.lineTo(x0, g.T + g.ih); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let m10 = -20; m10 <= 20; m10++) {
      const w = (m10 / 10) * 1000 / VOX_UM;
      if (w > t.wmax + 0.5 || w < t.wmin - 0.5) continue;
      const y = g.T + (t.wmax - w + 0.5) * g.s;
      const major = m10 % 5 === 0;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 - (major ? 7 : 3.5), y); ctx.stroke();
      if (major) ctx.fillText(m10 === 0 ? "0" : (m10 / 10).toFixed(1).replace("-", "−"), x0 - 10, y);
    }
    ctx.translate(11, g.T + g.ih / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("mm across the sheets", 0, 0);
    ctx.restore();
  }

  let loupe = null;
  const ZOOM = 3;
  function drawSection() {
    if (!R) return;
    const t = R.t, H = t.height;
    const wrap = $("#sectionWrap");
    const maxH = Math.max(240, Math.min(640, window.innerHeight * 0.66));
    const s = Math.min((wrap.clientWidth - PAD.l - PAD.r) / W, maxH / H);
    const iw = W * s, ih = H * s;
    const cw = Math.floor(iw + PAD.l + PAD.r), ch = Math.floor(ih + PAD.t + PAD.b);
    geom = { s, iw, ih, L: PAD.l, T: PAD.t };
    const ctx = fit($("#section"), cw, ch);
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.translate(PAD.l, PAD.t);
    ctx.beginPath(); ctx.rect(0, 0, iw, ih); ctx.clip();
    paintSection(ctx, s, iw, ih, 1);
    if (state.v === 0) {
      ctx.font = FONT(11, 600, "semi-expanded"); ctx.fillStyle = "rgba(243, 239, 230, 0.92)";
      ctx.fillText("SEED", 128.5 * s + 12 * s + 5, (t.wmax + 0.5) * s - 12 * s + 3);
    }
    ctx.restore();
    rulers(ctx, geom);
    if (loupe) {
      const r = Math.max(64, Math.min(120, iw / 6));
      ctx.save();
      ctx.beginPath(); ctx.arc(loupe.x, loupe.y, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = C.char; ctx.fillRect(loupe.x - r, loupe.y - r, 2 * r, 2 * r);
      ctx.translate(loupe.x, loupe.y); ctx.scale(ZOOM, ZOOM); ctx.translate(-loupe.x, -loupe.y);
      ctx.translate(PAD.l, PAD.t);
      paintSection(ctx, s, iw, ih, 1 / ZOOM);
      ctx.restore();
      ctx.strokeStyle = C.halo; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(loupe.x, loupe.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = C.bone; ctx.lineWidth = 1.25; ctx.stroke();
      for (let a = 0; a < 360; a += 15) {          // reticle ticks
        const rad = a * Math.PI / 180, long = a % 90 === 0;
        ctx.beginPath();
        ctx.moveTo(loupe.x + Math.cos(rad) * r, loupe.y + Math.sin(rad) * r);
        ctx.lineTo(loupe.x + Math.cos(rad) * (r - (long ? 9 : 4)), loupe.y + Math.sin(rad) * (r - (long ? 9 : 4)));
        ctx.stroke();
      }
      ctx.font = FONT(10, 700, "semi-expanded"); ctx.fillStyle = C.bone; ctx.textAlign = "center";
      ctx.fillText(`×${ZOOM}`, loupe.x, loupe.y + r + 14); ctx.textAlign = "left";
    }
    const out = $("#vOut");
    out.innerHTML = state.v === 0 ? `0.00 mm<small>through the seed</small>`
      : `${mm(Math.abs(state.v)).toFixed(2)} mm<small>${state.v > 0 ? "ahead of" : "behind"} the seed</small>`;
    $("#slider").value = state.v;
    drawCube();
  }

  // ------------------------------------------------------------ cube indicator
  function drawCube() {
    const a = 17, cx = 42, cy = 36;
    const P = (u, v, w) => [cx + (u - v) * 0.866 * a, cy - w * a + (u + v) * 0.5 * a];
    const pt = (p) => p.map((x) => x.toFixed(1)).join(",");
    const corners = [];
    for (const u of [-1, 1]) for (const v of [-1, 1]) for (const w of [-1, 1]) corners.push([u, v, w]);
    let edges = "", back = "";
    for (const c1 of corners) for (const c2 of corners) {
      const diff = c1.filter((x, i) => x !== c2[i]).length;
      if (diff !== 1 || c1.join() > c2.join()) continue;
      const hidden = [c1, c2].some((c) => c[0] === -1 && c[1] === -1 && c[2] === -1);
      const seg = `<line x1="${P(...c1)[0].toFixed(1)}" y1="${P(...c1)[1].toFixed(1)}" x2="${P(...c2)[0].toFixed(1)}" y2="${P(...c2)[1].toFixed(1)}"/>`;
      if (hidden) back += seg; else edges += seg;
    }
    const v = state.v / 128;
    const plane = [P(-1, v, -1), P(1, v, -1), P(1, v, 1), P(-1, v, 1)].map(pt).join(" ");
    const seed = P(0, 0, 0);
    $("#cube").innerHTML = `<g class="back">${back}</g><circle class="seed" cx="${seed[0]}" cy="${seed[1]}" r="2.2"/>` +
      `<polygon class="plane" points="${plane}"/><g class="edge">${edges}</g>`;
  }

  // ------------------------------------------------------------ discs (views from above)
  const DISC_SPAN = 296;   // voxels across the canvas, leaving room for the reticle outside r = 128
  function reticle(ctx, c, pv) {
    ctx.save();
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, 128 * pv, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = C.bone3;
    for (let a = 0; a < 360; a += 6) {
      const rad = a * Math.PI / 180, major = a % 30 === 0;
      const r0 = 131 * pv, r1 = (major ? 140 : 135) * pv;
      ctx.beginPath(); ctx.moveTo(c + Math.cos(rad) * r0, c + Math.sin(rad) * r0); ctx.lineTo(c + Math.cos(rad) * r1, c + Math.sin(rad) * r1); ctx.stroke();
    }
    ctx.restore();
  }
  function sliceLine(ctx, c, pv) {
    const half = Math.sqrt(Math.max(0, 128 * 128 - state.v * state.v)) * pv;
    const y = c - state.v * pv;
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = C.halo; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(c - half, y); ctx.lineTo(c + half, y); ctx.stroke();
    ctx.strokeStyle = C.bone; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = C.bone;                         // index marks just outside the disc
    for (const sgn of [-1, 1]) {
      const x = c + sgn * 143 * pv;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + sgn * 7, y - 4); ctx.lineTo(x + sgn * 7, y + 4); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  function drawChart(cv, img) {
    const size = cv.clientWidth;
    if (!size) return;
    const ctx = fit(cv, size, size, false);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2, pv = size / DISC_SPAN;
    ctx.fillStyle = C.char2;
    ctx.beginPath(); ctx.arc(c, c, 128 * pv, 0, Math.PI * 2); ctx.fill();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, c - 129 * pv, c - 129 * pv, 258 * pv, 258 * pv);
    ctx.save();
    ctx.strokeStyle = C.rule; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(c, c, 96 * pv, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]); ctx.strokeStyle = "rgba(239, 233, 220, 0.8)";
    ctx.beginPath(); ctx.arc(c, c, 12 * pv, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    reticle(ctx, c, pv);
    sliceLine(ctx, c, pv);
  }

  let blinkTimer = null;
  function drawTex() {
    if (!R) return;
    const cv = $("#tex");
    const size = cv.clientWidth;
    if (!size) return;
    const ctx = fit(cv, size, size, false);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2, pv = size / DISC_SPAN, rad = 128 * pv;
    const stock = R.img[`tex_${state.cut}_stock.webp`], tiled = R.img[`tex_${state.cut}_tiled.webp`];
    const cStock = R.img[`chart_${state.cut}_stock.png`], cTiled = R.img[`chart_${state.cut}_tiled.png`];
    const layer = (tex, chart) => {
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.drawImage(tex, c - 128.5 * pv, c - 128.5 * pv, 257 * pv, 257 * pv);
      if (state.texColor && chart) {
        ctx.save(); ctx.globalAlpha = 0.45; ctx.imageSmoothingEnabled = false;
        ctx.drawImage(chart, c - 129 * pv, c - 129 * pv, 258 * pv, 258 * pv);
        ctx.restore();
      }
    };
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, rad, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = C.char2; ctx.fillRect(0, 0, size, size);
    const tagL = $("#tagL"), tagR = $("#tagR");
    if (state.texMode === "swipe") {
      const sx = c + (state.swipe * 2 - 1) * rad;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, sx, size); ctx.clip(); layer(stock, cStock); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, size - sx, size); ctx.clip(); layer(tiled, cTiled); ctx.restore();
      ctx.fillStyle = C.bone; ctx.fillRect(sx - 0.75, 0, 1.5, size);
      tagL.hidden = false; tagR.hidden = false; tagL.textContent = "GrowPatch"; tagR.textContent = "Tiled";
    } else if (state.texMode === "blink") {
      layer(state.blinkOn ? tiled : stock, state.blinkOn ? cTiled : cStock);
      tagL.hidden = false; tagR.hidden = true; tagL.textContent = state.blinkOn ? "Tiled blend" : "GrowPatch";
    } else {
      layer(R.img["tex_ref.webp"], null);
      tagL.hidden = false; tagR.hidden = true; tagL.textContent = "Labeled sheet";
    }
    ctx.restore();
    if (state.texMode === "swipe") {               // handle on the rim
      const sx = c + (state.swipe * 2 - 1) * rad;
      ctx.fillStyle = C.bone;
      ctx.beginPath(); ctx.arc(sx, c, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.char;
      ctx.beginPath(); ctx.moveTo(sx - 6, c); ctx.lineTo(sx - 2, c - 3.5); ctx.lineTo(sx - 2, c + 3.5); ctx.fill();
      ctx.beginPath(); ctx.moveTo(sx + 6, c); ctx.lineTo(sx + 2, c - 3.5); ctx.lineTo(sx + 2, c + 3.5); ctx.fill();
    }
    reticle(ctx, c, pv);
    sliceLine(ctx, c, pv);
    $("#texHint").textContent = { swipe: "drag to compare", blink: "switches every 0.7 seconds", ref: "the hand-labeled sheet" }[state.texMode];
  }
  function setTexMode(mode) {
    state.texMode = mode;
    document.querySelectorAll("#texModes button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    clearInterval(blinkTimer);
    blinkTimer = null;
    if (mode === "blink") {
      state.blinkOn = true;
      blinkTimer = setInterval(() => { state.blinkOn = !state.blinkOn; drawTex(); }, 700);
    }
    drawTex();
  }

  function drawDiscs() {
    drawChart($("#chartDiff"), R.img[`diff_${state.cut}.png`]);
    drawChart($("#chartStock"), R.img[`chart_${state.cut}_stock.png`]);
    drawChart($("#chartTiled"), R.img[`chart_${state.cut}_tiled.png`]);
    drawTex();
  }
  function drawAll() { drawBand(); if (!R) return; drawSection(); drawDiscs(); }
  function drawForV() { if (!R) return; drawSection(); drawDiscs(); writeHash(); }

  // ------------------------------------------------------------ controls
  function setV(v) { state.v = Math.max(-128, Math.min(128, Math.round(v / 4) * 4)); drawForV(); }
  let playTimer = null;
  function setPlaying(on) {
    state.playing = on;
    $("#play").setAttribute("aria-pressed", String(on));
    $("#play").setAttribute("aria-label", on ? "Pause" : "Play through the cube");
    clearInterval(playTimer);
    if (on) playTimer = setInterval(() => setV(state.v >= 128 ? -128 : state.v + 4), 120);
  }
  function buildTicks() {
    const box = $("#railTicks");
    let html = "";
    for (let v = -128; v <= 128; v += 4) html += `<i style="left:${((v + 128) / 256 * 100).toFixed(3)}%"></i>`;
    for (const m of [-1, -0.5, 0, 0.5, 1]) {
      const v = m * 1000 / VOX_UM;
      const left = ((v + 128) / 256 * 100).toFixed(3);
      html += `<i class="major" style="left:${left}%"></i><b style="left:${left}%">${m === 0 ? "0" : m.toFixed(1).replace("-", "−")}${m === 1 ? " mm" : ""}</b>`;
    }
    box.innerHTML = html;
  }
  function buildCutoffs() {
    const g = $("#cutoffs");
    for (const c of CUTS) {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "radio"); b.dataset.cut = c;
      b.textContent = M.cutoffs[c];
      b.setAttribute("aria-label", `Cutoff ${M.cutoffs[c]}`);
      b.addEventListener("click", () => setCut(c));
      g.appendChild(b);
    }
    g.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const k = CUTS.indexOf(state.cut) + (e.key === "ArrowRight" ? 1 : -1);
      setCut(CUTS[(k + CUTS.length) % CUTS.length]);
      g.querySelector(`[data-cut="${state.cut}"]`).focus();
    });
  }
  function setCut(c) {
    state.cut = c;
    document.querySelectorAll("#cutoffs button").forEach((b) => {
      const on = b.dataset.cut === c;
      b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1;
    });
    renderSummary(); buildList(); renderMeta(); writeHash(); drawAll();
  }

  function bind() {
    $("#slider").addEventListener("input", (e) => { setPlaying(false); setV(Number(e.target.value)); });
    $("#play").addEventListener("click", () => setPlaying(!state.playing));
    $("#tLabels").addEventListener("change", (e) => { state.labels = e.target.checked; drawSection(); });
    $("#tStock").addEventListener("change", (e) => { state.stock = e.target.checked; drawSection(); });
    $("#tTiled").addEventListener("change", (e) => { state.tiled = e.target.checked; drawSection(); });
    $("#tTexColor").addEventListener("change", (e) => { state.texColor = e.target.checked; drawTex(); });
    $("#sort").addEventListener("click", (e) => {
      state.sortById = !state.sortById;
      e.currentTarget.setAttribute("aria-pressed", String(state.sortById));
      e.currentTarget.textContent = state.sortById ? "Sort by area gained" : "Sort by region";
      buildList();
    });
    document.querySelectorAll("#texModes button").forEach((b) => b.addEventListener("click", () => setTexMode(b.dataset.mode)));
    for (const id of ["#chartDiff", "#chartStock", "#chartTiled"]) {
      $(id).addEventListener("click", (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPlaying(false);
        setV(((r.height / 2) - (e.clientY - r.top)) / (r.height / DISC_SPAN));
      });
    }
    const tex = $("#tex");
    const swipeTo = (e) => {
      const r = tex.getBoundingClientRect();
      const c = r.width / 2, rad = 128 * r.width / DISC_SPAN;
      state.swipe = Math.max(0, Math.min(1, ((e.clientX - r.left - c) / rad + 1) / 2));
      drawTex();
    };
    tex.addEventListener("pointerdown", (e) => { if (state.texMode !== "swipe") setTexMode("swipe"); tex.setPointerCapture(e.pointerId); swipeTo(e); });
    tex.addEventListener("pointermove", (e) => { if (tex.hasPointerCapture(e.pointerId)) swipeTo(e); });
    tex.tabIndex = 0;
    tex.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      state.swipe = Math.max(0, Math.min(1, state.swipe + (e.key === "ArrowRight" ? 0.05 : -0.05)));
      drawTex();
    });
    const section = $("#section");
    section.tabIndex = 0;
    let raf = 0;
    const redraw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawSection); };
    const moveLoupe = (e) => {
      if (!geom) return;
      const inside = e.offsetX >= geom.L && e.offsetX <= geom.L + geom.iw && e.offsetY >= geom.T && e.offsetY <= geom.T + geom.ih;
      loupe = inside ? { x: e.offsetX, y: e.offsetY } : null;
      redraw();
    };
    section.addEventListener("pointermove", moveLoupe);
    section.addEventListener("pointerdown", moveLoupe);
    section.addEventListener("pointerleave", () => { loupe = null; redraw(); });
    document.addEventListener("keydown", (e) => {
      if (!(e.target === document.body || e.target === section)) return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); setV(state.v + (e.key === "ArrowRight" ? 4 : -4)); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const order = sortedRows().map((o) => o.r.id);
        const k = order.indexOf(state.region) + (e.key === "ArrowDown" ? 1 : -1);
        if (order[k]) selectRegion(order[k]);
      } else if (e.key === " ") { e.preventDefault(); setPlaying(!state.playing); }
    });
    window.addEventListener("hashchange", () => {
      const before = state.region, cut = state.cut;
      readHash();
      if (state.cut !== cut) setCut(state.cut);
      if (state.region !== before) selectRegion(state.region); else drawForV();
    });
    let rr = 0;
    new ResizeObserver(() => { cancelAnimationFrame(rr); rr = requestAnimationFrame(drawAll); }).observe(document.body);
  }

  readHash();
  buildCutoffs();
  buildTicks();
  bind();
  setCut(state.cut);
  selectRegion(state.region);
  initBand();
  document.fonts?.ready.then(() => R && drawSection());
})();
