/* =====================================================================
   SGLang × AMD Instinct — serving datasheet renderer
   Reads window.MODELS / window.HW (from models.js). Buildless, no deps.
   ===================================================================== */
(function () {
  "use strict";

  var MODELS = window.MODELS || [];
  var HW = (window.HW && window.HW.hardware) || [];
  var HWBY = {};
  HW.forEach(function (h) { HWBY[h.gfx] = h; });

  var STRATS = ["low-latency", "balanced", "high-throughput"];
  var GFXES = ["gfx942", "gfx950"];
  var GFXNAME = { gfx942: "MI300X", gfx950: "MI355X" };

  var reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var state = { modelId: null, gfx: null, strategy: null };

  // ---- SGLang flag glossary: the "standardized arguments" reference --------
  var FLAGS = {
    "--model-path": "HuggingFace repo or local path to the weights.",
    "--served-model-name": "Name clients pass in the OpenAI `model` field.",
    "--trust-remote-code": "Allow the model's custom modeling code to load (required for new architectures).",
    "--tp": "Tensor-parallel degree — shards each layer across this many GPUs.",
    "--tp-size": "Tensor-parallel degree — shards each layer across this many GPUs.",
    "--ep-size": "Expert-parallel degree — shards MoE experts across GPUs (1 = TP-sharded experts).",
    "--dp": "Data-parallel degree for attention/replicas.",
    "--dp-size": "Data-parallel degree for attention/replicas.",
    "--enable-dp-attention": "Run attention data-parallel across GPUs to cut KV duplication.",
    "--moe-a2a-backend": "All-to-all backend for expert routing (e.g. deepep, mori).",
    "--attention-backend": "Unified attention kernel backend.",
    "--prefill-attention-backend": "Attention kernel used during prefill (heavy, long sequences).",
    "--decode-attention-backend": "Attention kernel used during decode (per-token).",
    "--dsa-prefill-backend": "DeepSeek Sparse Attention prefill backend (e.g. tilelang).",
    "--dsa-decode-backend": "DeepSeek Sparse Attention decode backend (e.g. tilelang).",
    "--kv-cache-dtype": "Storage dtype for the KV cache. fp8_e4m3 roughly doubles the pool; the DSA tilelang path accepts it on ROCm but not on CUDA, so a recipe that sets it is target-specific.",
    "--chunked-prefill-size": "Max tokens per prefill chunk — caps the prefill tile size; lower = safer, higher = lower TTFT.",
    "--mem-fraction-static": "Fraction of VRAM reserved for weights + static buffers; the rest is KV cache.",
    "--cuda-graph-max-bs": "Largest batch size captured into a HIP/CUDA graph.",
    "--cuda-graph-bs": "Explicit batch sizes to capture into graphs.",
    "--max-running-requests": "Concurrency ceiling for the scheduler. It is an upper bound, not the binding one: whichever of this and floor(KV pool ÷ peak context) is smaller decides how many requests actually run.",
    "--schedule-policy": "Order the waiting queue is admitted in: fcfs, or lpm to run longest-prefix-match first. Only matters once the queue is non-empty — then it decides how much a full pool costs.",
    "--num-continuous-decode-steps": "Decode steps run per scheduler iteration. Higher amortises scheduling overhead across the batch at the cost of coarser admission.",
    "--watchdog-timeout": "Seconds before the watchdog kills a stuck forward pass.",
    "--disable-cuda-graph": "Turn off HIP/CUDA graph replay (correctness-first / unsupported paths).",
    "--disable-radix-cache": "Turn off prefix (radix) caching.",
    "--quantization": "Weight quantization scheme to load.",
    "--reasoning-parser": "Splits `<think>` reasoning blocks out of the message content.",
    "--tool-call-parser": "Parses tool/function calls out of the message content.",
    "--context-length": "Override the served maximum context length.",
    "--max-total-tokens": "Hard cap on total tokens across the running batch.",
    "--host": "Bind address for the server.",
    "--port": "Bind port for the server.",
    "--tensor-parallel-size": "Tensor-parallel degree — long form of --tp.",
    "--dtype": "Compute dtype for the unquantized tensors (quantized weights keep their own scheme).",
    "--page-size": "Tokens per KV-cache page — larger pages cut index overhead, waste more on short sequences.",
    "--cuda-graph-max-bs-decode": "Largest decode batch size captured into a HIP/CUDA graph.",
    "--max-mamba-cache-size": "Slots in the linear-attention (Mamba/GDN/KDA) state pool — the second, fixed-size memory pool hybrid models need.",
    "--disable-shared-experts-fusion": "Keep MoE shared experts as separate GEMMs instead of fusing them into the routed path.",
    "--nsa-prefill-backend": "Native Sparse Attention prefill backend (deprecated alias of --dsa-prefill-backend).",
    "--nsa-decode-backend": "Native Sparse Attention decode backend (deprecated alias of --dsa-decode-backend).",
    "--speculative-algorithm": "Speculative decoding algorithm (EAGLE, EAGLE3, NEXTN, NGRAM, DFLASH, DSPARK …).",
    "--speculative-draft-model-path": "Draft model the speculative algorithm proposes with.",
    "--speculative-num-draft-tokens": "Draft tokens proposed per step; the target verifies this many at once.",
    "--speculative-num-steps": "Draft-model forward passes per proposal round.",
    "--speculative-eagle-topk": "Branching factor of the EAGLE draft tree; 1 is a single chain.",
    "--speculative-dspark-block-size": "DSPARK draft block size (gamma). The verify window is gamma+1, so this sets --speculative-num-draft-tokens implicitly — set this, not that.",
    "--mamba-radix-cache-strategy": "How prefix caching stores linear-attention (Mamba/GDN/KDA) state: no_buffer, extra_buffer, or extra_buffer_lazy. Costs state slots per request, which caps the runnable batch.",
    "--mamba-ssm-dtype": "Storage dtype for SSM states in the linear-attention cache — bfloat16 halves the pool at some precision risk.",
    "--mamba-full-memory-ratio": "Size of the linear-attention state budget relative to the KV cache budget (default 0.9).",
    "--enable-linear-replayssm-spec": "Replace the speculative verifier's per-draft SSM state snapshots with a per-slot ring plus periodic flush, freeing the verify scratch.",
    "--schedule-conservativeness": "How cautious the scheduler is about admitting requests; lower admits more, higher retracts less.",
    "--skip-server-warmup": "Skip the warmup forward pass at startup.",
    "--dist-timeout": "Seconds before a distributed collective is considered hung."
  };

  // ---------------------------------------------------------------- helpers
  function el(html) { var t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmt(n, d) { if (n == null || isNaN(n)) return "—"; return Number(n).toLocaleString("en-US", { maximumFractionDigits: d == null ? 1 : d }); }
  function byId(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- prose typography
  // Summaries, gotchas and notes are plain strings in models.js, but they are
  // dense with identifiers: flags, env vars, patch files, PR numbers. Set as
  // running text they read as one grey mass, so the renderer marks the
  // identifiers up and fixes the ASCII stand-ins (-> -- ~ 8x) on the way through.
  var ORGS = ["moonshotai", "zai-org", "Qwen", "sgl-project", "deepseek-ai",
              "lmsysorg", "rocm", "jhinpan", "JinnP", "RadixArk", "Arist12"];

  // Flags are usually written --like-this, but summaries also name them bare
  // ("chunked-prefill-size measured within noise"). Take the bare forms from the
  // glossary so the two never disagree; the length floor keeps ordinary
  // hyphenated English out.
  function bareFlagNames() {
    var seen = {};
    Object.keys(FLAGS).forEach(function (f) {
      var bare = f.replace(/^--/, "");
      if (bare.length >= 12 && bare.indexOf("-") > -1) seen[bare] = 1;
    });
    return Object.keys(seen).sort(function (a, b) { return b.length - a.length; });
  }

  var CODEISH = new RegExp([
    "`[^`\\n]+`",                                                     // already marked up
    "--[a-z][\\w-]*",                                                 // --launch-flags
    "[\\w./-]*[\\w-]\\.(?:py|patch|csv|sh|json|ya?ml|md|txt)\\b",     // file names
    "(?:[\\w.-]+/)?[\\w.-]*#\\d{3,7}\\b",                             // sglang#32548, #28685
    "\\b(?:" + ORGS.join("|") + ")/[\\w.:-]+",                        // HF repos, image tags
    "\\b[A-Za-z_][A-Za-z0-9]*(?:_[A-Za-z0-9*]+)+(?:=[^\\s,;)]*[^\\s,;).])?", // snake_case, ENV=value
    "\\b(?:" + bareFlagNames().join("|") + ")\\b"                     // flags named bare
  ].join("|"), "g");

  function typog(s) {
    return s
      .replace(/ -> /g, " → ")
      .replace(/ --+ /g, " — ")
      .replace(/ - /g, " — ")
      .replace(/~(?=\d)/g, "≈")
      .replace(/(\d(?:\.\d+)?)x\b/g, "$1×")
      .replace(/(\d)\s(ms|s|min|GB|TB|GiB|MB|tok\/s)\b/g, "$1\u00A0$2");
  }

  // Issue refs are written three ways: #28685, sglang#9897, ROCm/rocm-libraries#8639.
  // Only the first two are ours to resolve against sgl-project.
  function codeSpan(tok) {
    var pr = tok.match(/^(?:([\w.-]+)\/)?([\w.-]*)#(\d{3,7})$/);
    if (pr) {
      var repo = (pr[1] ? pr[1] : "sgl-project") + "/" + (pr[2] || "sglang");
      return '<a class="ref" href="https://github.com/' + repo + "/issues/" + pr[3] +
        '"><code>' + esc(tok) + "</code></a>";
    }
    var text = tok.charAt(0) === "`" ? tok.slice(1, -1) : tok;
    return '<code class="' + (text.indexOf("--") === 0 ? "f" : "id") + '">' + esc(text) + "</code>";
  }

  function prose(raw) {
    if (raw == null || raw === "") return "";
    var s = String(raw), out = "", last = 0, m;
    CODEISH.lastIndex = 0;
    while ((m = CODEISH.exec(s)) !== null) {
      out += esc(typog(s.slice(last, m.index))) + codeSpan(m[0]);
      last = m.index + m[0].length;
      if (m[0] === "") CODEISH.lastIndex++;          // never spin on an empty match
    }
    return out + esc(typog(s.slice(last)));
  }

  // ---------------------------------------------------------------- roofline
  function bestDecode(cfg) {
    var rows = (cfg.benchmarks || []).map(function (b) {
      var d = b.decode_tok_s != null ? b.decode_tok_s : (b.tpot_ms ? 1000 / b.tpot_ms : null);
      return { conc: b.concurrency, d: d };
    }).filter(function (r) { return r.d != null; });
    if (!rows.length) return null;
    var bs1 = rows.filter(function (r) { return r.conc === 1 || r.conc == null; });
    var pool = bs1.length ? bs1 : rows;
    return Math.max.apply(null, pool.map(function (r) { return r.d; }));
  }
  function bestPrefill(cfg) {
    var vals = (cfg.benchmarks || []).map(function (b) { return b.prefill_tok_s; })
      .filter(function (v) { return v != null; });
    return vals.length ? Math.max.apply(null, vals) : null;
  }
  function roofline(model, cfg) {
    var hw = HWBY[cfg.gfx];
    if (!hw || !model.active_params_billions || !model.bytes_per_param) return null;
    var gpus = cfg.gpus || 8;
    var activeBytes = model.active_params_billions * 1e9 * model.bytes_per_param;
    var activeParams = model.active_params_billions * 1e9;
    var aggBW = gpus * hw.mem_bw_tbps * 1e12;
    var decodeSOL = aggBW / activeBytes;
    var computePeak = (model.bytes_per_param === 1 ? hw.fp8_tflops : hw.bf16_tflops) * 1e12;
    var prefillSOL = (gpus * computePeak) / (2 * activeParams);
    var md = bestDecode(cfg), mp = bestPrefill(cfg);
    return {
      decode: md == null ? null : { measured: md, sol: decodeSOL, pct: (md / decodeSOL) * 100, bound: "memory-bound" },
      prefill: mp == null ? null : { measured: mp, sol: prefillSOL, pct: (mp / prefillSOL) * 100, bound: "compute-bound" }
    };
  }

  // ---------------------------------------------------------------- command highlighter
  function tokenizeCmd(raw) {
    return esc(raw).split("\n").map(function (line) {
      if (/^\s*#/.test(line)) return '<span class="tok-cmt">' + line + "</span>";
      // inline comment
      var cmt = "";
      var ci = line.search(/\s#\s/);
      if (ci > -1) { cmt = '<span class="tok-cmt">' + line.slice(ci) + "</span>"; line = line.slice(0, ci); }
      // trailing continuation
      line = line.replace(/\\\s*$/, '<span class="tok-cont">\\</span>');
      // long flags
      line = line.replace(/(^|\s)(--[A-Za-z][\w-]*)/g, '$1<span class="tok-flag">$2</span>');
      // leading program
      line = line.replace(/^(\s*)(python3|docker|curl|sudo|export|for|pip|bash)\b/, '$1<span class="tok-prog">$2</span>');
      return line + cmt;
    }).join("\n");
  }

  // Anchor on the first long flag rather than on a program name: recipes are
  // written against both `python3 -m sglang.launch_server` and the newer
  // `sglang serve`, and env-var exports may precede either.
  function parseFlags(cmd) {
    var clean = cmd.replace(/\\\s*\n/g, " ").replace(/#[^\n]*/g, " ");
    var toks = clean.split(/\s+/).filter(Boolean);
    var out = [], i = 0;
    while (i < toks.length && toks[i].indexOf("--") !== 0) i++;
    for (; i < toks.length; i++) {
      var t = toks[i];
      if (t.indexOf("--") === 0) {
        var flag = t, vals = [];
        while (i + 1 < toks.length && toks[i + 1].indexOf("-") !== 0) { vals.push(toks[++i]); }
        out.push({ flag: flag, value: vals.join(" ") });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- hardware strip
  function renderHW() {
    var host = byId("hwstrip");
    if (!host) return;
    host.innerHTML = "";
    HW.forEach(function (h) {
      host.appendChild(el(
        '<div class="hwcard">' +
          '<div class="hwtop">' +
            '<span class="hwname">' + esc(h.name) + '</span>' +
            '<span><span class="gfx">' + esc(h.gfx) + '</span> <span class="arch">' + esc(h.arch || "") + "</span></span>" +
          "</div>" +
          '<div class="hwspecs">' +
            cellHW("HBM", fmt(h.hbm_gb, 0), h.hbm_type) +
            cellHW("BW", fmt(h.mem_bw_tbps, 1), "TB/s") +
            cellHW("FP8", fmt(h.fp8_tflops, 0), "TFLOP/s") +
            cellHW("BF16", fmt(h.bf16_tflops, 0), "TFLOP/s") +
          "</div>" +
        "</div>"));
    });
  }
  function cellHW(k, v, unit) {
    return '<div class="cell"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      (unit ? ' <small>' + esc(unit) + "</small>" : "") + "</div></div>";
  }

  // ---------------------------------------------------------------- model tabs
  function renderTabs() {
    var host = byId("modeltabs");
    host.innerHTML = "";
    MODELS.forEach(function (m) {
      var gap = m.status === "not_benchmarked";
      var tab = el(
        '<button class="mtab" role="tab" data-model="' + esc(m.id) + '" aria-selected="false">' +
          '<span class="dot' + (gap ? " gap" : "") + '"></span>' +
          esc(m.name) + ' <span class="fam">' + esc(m.family) + "</span>" +
        "</button>");
      tab.addEventListener("click", function () { selectModel(m.id); });
      host.appendChild(tab);
    });
  }

  function configFor(model, gfx, strat) {
    return (model.configs || []).filter(function (c) { return c.gfx === gfx && c.strategy === strat; })[0];
  }
  function firstVerified(model) {
    var v = (model.configs || []).filter(function (c) { return c.verified; });
    return (v[0] || (model.configs || [])[0]);
  }

  // ---------------------------------------------------------------- at a glance
  // The per-model cards answer "how do I run this one". This answers the
  // question they can't: which model/config to reach for, and what it costs.
  function peakTotal(cfg) {
    var best = null;
    (cfg.benchmarks || []).forEach(function (b) {
      if (b.total_tok_s != null && (!best || b.total_tok_s > best.v)) {
        best = { v: b.total_tok_s, conc: b.concurrency };
      }
    });
    return best;
  }
  function accValue(cfg, name) {
    var hit = (cfg.accuracy || []).filter(function (a) { return a.name === name; })[0];
    return hit ? hit.value : null;
  }
  function renderCompare() {
    var host = byId("compare-body");
    if (!host) return;
    var rows = [];
    MODELS.forEach(function (m) {
      (m.configs || []).forEach(function (c) {
        if (!c.verified) return;
        rows.push({ m: m, c: c, dec: bestDecode(c), peak: peakTotal(c),
                    gsm: accValue(c, "GSM8K"), aime: accValue(c, "AIME25") });
      });
    });
    if (!rows.length) { host.innerHTML = ""; return; }
    var body = rows.map(function (r) {
      var peak = r.peak
        ? fmt(r.peak.v, 0) + (r.peak.conc ? ' <small>@c' + r.peak.conc + "</small>" : "")
        : "—";
      return '<tr tabindex="0" role="button" data-model="' + esc(r.m.id) + '" data-gfx="' +
        esc(r.c.gfx) + '" data-strat="' + esc(r.c.strategy) + '">' +
        "<td class='cmp-model'>" + esc(r.m.name) + "</td>" +
        "<td>" + esc(r.c.hw_name) + " <small>" + esc(r.c.gfx) + "</small></td>" +
        "<td><span class='cmp-strat'>" + esc(r.c.strategy) + "</span></td>" +
        "<td>" + esc(r.m.params_active || "—") + " <small>active</small></td>" +
        "<td class='hl'>" + (r.dec == null ? "—" : fmt(r.dec, 0)) + "</td>" +
        "<td>" + peak + "</td>" +
        "<td>" + (r.gsm ? esc(r.gsm) : "—") + "</td>" +
        "<td>" + (r.aime ? esc(r.aime) : "—") + "</td></tr>";
    }).join("");
    host.innerHTML =
      '<div class="dtable-scroll"><table class="dtable cmp"><thead><tr>' +
      "<th>model</th><th>target</th><th>strategy</th><th>params</th>" +
      "<th>BS=1 decode<br><small>tok/s</small></th><th>peak total<br><small>tok/s</small></th>" +
      "<th>GSM8K</th><th>AIME25</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table>" +
      "<caption>Every verified cell on this site, one row each. BS=1 decode is the single-stream floor; " +
      "peak total is the best aggregate throughput measured, at the concurrency noted. Blank accuracy " +
      "cells are not-yet-run, never failures. Click a row to open its recipe.</caption></div>";
    host.querySelectorAll("tbody tr").forEach(function (tr) {
      var go = function () {
        selectModel(tr.dataset.model, { gfx: tr.dataset.gfx, strategy: tr.dataset.strat });
        var t = byId("models");
        if (t) t.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      };
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });
    });
  }

  // ---------------------------------------------------------------- coverage matrix
  function renderMatrix(model) {
    var host = byId("matrixwrap");
    var head =
      '<div class="matrix-head"><span class="t">Coverage matrix — ' + esc(model.name) + " · " + esc(model.precision) + "</span>" +
      '<span class="matrix-legend"><i class="v">verified</i><i class="g">not benchmarked</i></span></div>';
    var thead = "<thead><tr><th>target \\ strategy</th>" +
      STRATS.map(function (s) { return "<th>" + esc(s) + "</th>"; }).join("") + "</tr></thead>";
    var body = "<tbody>" + GFXES.map(function (gfx) {
      var row = "<tr><th>" + esc(gfx) + "<br><small>" + esc(GFXNAME[gfx]) + "</small></th>";
      row += STRATS.map(function (strat) {
        var c = configFor(model, gfx, strat);
        var active = (gfx === state.gfx && strat === state.strategy) ? " active" : "";
        if (c && c.verified) {
          var d = bestDecode(c);
          return '<td><button class="mcell has' + active + '" data-gfx="' + esc(gfx) + '" data-strat="' + esc(strat) + '">' +
            '<span class="tick">✓</span>' + (d ? '<span class="lbl">' + fmt(d, 0) + " tok/s dec</span>" : "") + "</button></td>";
        }
        if (c) {
          return '<td><button class="mcell has doc' + active + '" data-gfx="' + esc(gfx) + '" data-strat="' + esc(strat) + '">' +
            '<span class="tick doc">○</span><span class="lbl">documented</span></button></td>';
        }
        return '<td><div class="mcell">—</div></td>';
      }).join("");
      return row + "</tr>";
    }).join("") + "</tbody>";
    host.innerHTML = head + '<table class="matrix">' + thead + body + "</table>";
    host.querySelectorAll(".mcell.has").forEach(function (b) {
      b.addEventListener("click", function () { selectConfig(model, b.dataset.gfx, b.dataset.strat); });
    });
  }

  // ---------------------------------------------------------------- deep links
  // #m=<model> selects a model; #m=<model>&c=<gfx>:<strategy> selects one cell.
  // Models whose cells disagree (Kimi-K3's DSpark vs plain) are only shareable
  // with the cell part, so every cell click writes it back.
  function syncHash() {
    var h = "#m=" + state.modelId;
    if (state.gfx && state.strategy) h += "&c=" + state.gfx + ":" + state.strategy;
    try { history.replaceState(null, "", h); } catch (e) {}
  }
  function parseHash() {
    var raw = location.hash.replace(/^#/, "");
    if (!raw) return {};
    var out = {};
    raw.split("&").forEach(function (part) {
      var kv = part.split("=");
      if (kv[0] === "m") out.model = decodeURIComponent(kv[1] || "");
      if (kv[0] === "c") {
        var cell = decodeURIComponent(kv[1] || "").split(":");
        out.gfx = cell[0]; out.strategy = cell[1];
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- recipe card
  function selectModel(id, cell) {
    state.modelId = id;
    var model = MODELS.filter(function (m) { return m.id === id; })[0];
    document.querySelectorAll(".mtab").forEach(function (t) {
      t.setAttribute("aria-selected", String(t.dataset.model === id));
    });
    var want = cell && cell.gfx ? configFor(model, cell.gfx, cell.strategy) : null;
    var pick = want || firstVerified(model);
    state.gfx = pick ? pick.gfx : (cell && cell.gfx) || GFXES[0];
    state.strategy = pick ? pick.strategy : (cell && cell.strategy) || STRATS[0];
    syncHash();
    renderMatrix(model);
    renderRecipe(model, pick);
  }

  function selectConfig(model, gfx, strat) {
    state.gfx = gfx; state.strategy = strat;
    syncHash();
    renderMatrix(model);
    renderRecipe(model, configFor(model, gfx, strat));
    var r = byId("recipe");
    if (r) r.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }

  function renderRecipe(model, cfg) {
    var host = byId("recipe");
    if (!cfg) { host.innerHTML = emptyState(model); wireCopy(host); return; }
    var rl = cfg.verified ? roofline(model, cfg) : null;
    var unverifiedNote = !cfg.verified
      ? '<div class="block" style="border-top:0;padding-top:20px"><div class="badge gap" style="margin-bottom:8px">not benchmarked</div>' +
        '<p class="lead" style="margin:0">This config is documented and copy-paste ready, but we have not measured it end-to-end yet — no performance or accuracy numbers are published below.</p></div>'
      : "";

    var chips =
      '<span class="chip gfx">' + esc(cfg.gfx) + " · " + esc(cfg.hw_name) + "</span>" +
      '<span class="chip">' + esc(cfg.strategy) + "</span>" +
      '<span class="chip">' + esc(cfg.gpus) + "× GPU</span>" +
      statusBadge(model.status);

    var html =
      '<div class="rc-head">' +
        '<div class="rc-title"><span class="name">' + esc(model.name) + "</span>" +
          '<span class="hf">↳ <a href="https://huggingface.co/' + esc(model.hf_path) + '">' + esc(model.hf_path) + "</a></span></div>" +
        '<div class="rc-chips">' + chips + "</div>" +
      "</div>" +
      specSheet(model, cfg) +
      '<div class="rc-body">' +
        unverifiedNote +
        summaryBlock(model) +
        (rl ? rooflineBlock(rl, cfg) : "") +
        commandBlock(cfg) +
        argBlock(cfg) +
        aiterBlock(cfg.aiter) +
        envBlock(cfg.env) +
        benchBlock(cfg) +
        nvBlock(cfg) +
        accBlock(cfg.accuracy) +
        gotchaBlock(cfg.gotchas) +
        provBlock(cfg.provenance) +
      "</div>";
    host.innerHTML = html;
    wireCopy(host);
    revealGauges(host);
  }

  function statusBadge(s) {
    if (s === "verified") return '<span class="badge verified">verified</span>';
    if (s === "partial") return '<span class="badge partial">partial</span>';
    return '<span class="badge gap">not benchmarked</span>';
  }
  function specCell(k, v, sub) {
    return '<div class="cell"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) +
      (sub ? ' <small>' + esc(sub) + "</small>" : "") + "</div></div>";
  }

  // Context windows are quoted in tokens. 1048576 is noise; 1M is a spec.
  // Only whole standalone counts are rewritten, so "max_model_len=1048576" is left
  // alone — that one is a literal you might type.
  function fmtContext(v) {
    if (!v) return "—";
    return String(v).replace(/(^|[\s(])(\d{4,})(?=$|[\s),;])/g, function (all, pre, n) {
      var t = Number(n);
      if (t % 1048576 === 0) return pre + t / 1048576 + "M";
      if (t % 1024 === 0) return pre + t / 1024 + "k";
      return all;
    });
  }

  // A datasheet puts short values in a strip and long ones on their own line.
  // Architecture and precision are sentences for some models and two words for
  // others, so the split is by length, not by field.
  var SPEC_INLINE_MAX = 34;
  function specWords(s) {
    return String(s).toLowerCase().replace(/[(),;:]/g, " ").split(/\s+/).filter(Boolean);
  }
  function saysNothingNew(a, b) {          // is b entirely contained in a?
    var seen = {};
    specWords(a).forEach(function (w) { seen[w] = 1; });
    return specWords(b).every(function (w) { return seen[w]; });
  }
  function specSheet(model, cfg) {
    // The model's precision and the cell's quant string are the same fact at two
    // resolutions. Print both only when the coarser one actually says something
    // the detailed one leaves out (Kimi-K3's effective bytes/param, for example).
    var precision = model.precision || "";
    var quant = cfg.quant || "";
    if (precision && quant) {
      if (saysNothingNew(quant, precision)) { precision = quant; quant = ""; }
      else if (saysNothingNew(precision, quant)) { quant = ""; }
    }
    var specs = [
      { k: "Params", v: model.params_total || "—", sub: model.params_active ? model.params_active + " active" : "" },
      { k: "Context", v: fmtContext(model.context_len) },
      { k: "Weights", v: model.weights_gb ? fmt(model.weights_gb, 0) + " GB" : "—" },
      { k: "Bytes/param", v: model.bytes_per_param ? String(model.bytes_per_param) : "", sub: "active set" },
      { k: "Precision", v: precision },
      { k: "Architecture", v: model.architecture || "" },
      { k: "Checkpoint", v: quant }
    ].filter(function (s) { return s.v; });

    var strip = specs.filter(function (s) { return s.v.length <= SPEC_INLINE_MAX; });
    var notes = specs.filter(function (s) { return s.v.length > SPEC_INLINE_MAX; });
    return '<div class="rc-spec">' +
      strip.map(function (s) { return specCell(s.k, s.v, s.sub); }).join("") + "</div>" +
      (notes.length ? '<div class="rc-notes">' + notes.map(function (s) {
        return '<div class="specrow"><div class="k">' + esc(s.k) + "</div>" +
          '<div class="v prose">' + prose(s.v) + "</div></div>";
      }).join("") + "</div>" : "");
  }

  // The summary is the one part of a card that is pure prose, and the longest.
  // Written as one string it renders as twenty unbroken lines, so it is stored as
  // topic-tagged paragraphs: a lede, then one claim per row against a label rail.
  // A plain string still works — it just renders as the lede.
  function summaryBlock(model) {
    if (!model.summary) return "";
    var items = Array.isArray(model.summary) ? model.summary : [{ text: model.summary }];
    var rows = items.map(function (it) {
      var text = typeof it === "string" ? it : it.text;
      if (!text) return "";
      var topic = typeof it === "string" ? "" : it.topic;
      if (!topic) return '<p class="lede prose">' + prose(text) + "</p>";
      return '<div class="srow"><div class="st">' + esc(topic) + "</div>" +
        '<p class="sp prose">' + prose(text) + "</p></div>";
    }).join("");
    return rows ? '<div class="block"><div class="summary">' + rows + "</div></div>" : "";
  }

  function rooflineBlock(rl, cfg) {
    if (!rl || !rl.decode) return "";
    return '<div class="block"><h3>Distance to roofline <span class="hint">measured single-stream decode ÷ memory-bound ceiling · BS=1 · ' +
      esc(cfg.gfx) + '</span></h3><div class="roofline">' + gauge("Decode", rl.decode, "tok/s") +
      '<p class="roofline-note">Ceiling is the theoretical HBM-bandwidth limit, not a BS=1 target — the empty span is the optimization headroom this cookbook tracks. ' +
      '<a href="#method-detail">formula ↓</a></p></div></div>';
  }
  function gauge(label, g, unit) {
    var pct = Math.max(0, Math.min(100, g.pct));
    var pctTxt = g.pct < 1 ? g.pct.toFixed(2) : g.pct.toFixed(1);
    return '<div class="gauge">' +
      '<div class="gauge-top"><span class="gauge-label">' + esc(label) +
        '<span class="bound">' + esc(g.bound) + "</span></span>" +
        '<span class="gauge-pct">' + pctTxt + '<small>% of SOL</small></span></div>' +
      '<div class="track"><div class="fill" data-w="' + pct + '"></div>' +
        '<span class="headroom">headroom to physical limit →</span>' +
        '<span class="ceiling"></span></div>' +
      '<div class="gauge-foot"><span class="meas">measured <b>' + fmt(g.measured, 0) + " " + esc(unit) + "</b></span>" +
        '<span class="sol">SOL <b>' + fmt(g.sol, 0) + " " + esc(unit) + "</b></span></div>" +
      "</div>";
  }

  function commandBlock(cfg) {
    var cmd = cfg.launch_python || "";
    var tag = /\bsglang\s+serve\b/.test(cmd) ? "bash · sglang serve"
      : /launch_server/.test(cmd) ? "python · sglang.launch_server"
      : "bash";
    return '<div class="block"><h3>Launch command <span class="hint">verified, copy-paste ready</span></h3>' +
      '<div class="cmd" data-cmd><div class="cmd-bar"><span class="tag">' + esc(tag) + "</span>" +
      '<button class="copy-btn" data-copy>Copy</button></div>' +
      "<pre><code>" + tokenizeCmd(cfg.launch_python || "") + "</code></pre></div></div>";
  }

  function argBlock(cfg) {
    var flags = parseFlags(cfg.launch_python || "");
    if (!flags.length) return "";
    var rows = flags.map(function (f) {
      var why = FLAGS[f.flag];
      return "<tr><td class='flag'>" + esc(f.flag) + "</td><td class='val'>" + esc(f.value || "✓") +
        "</td><td class='why prose'>" + (why ? prose(why) : "—") + "</td></tr>";
    }).join("");
    return '<div class="block"><h3>Argument reference <span class="hint">every flag, explained</span></h3>' +
      '<table class="argtable"><thead><tr><th>flag</th><th>value</th><th>what it does</th></tr></thead><tbody>' +
      rows + "</tbody></table></div>";
  }

  function aiterBlock(a) {
    if (!a) return "";
    var arts = (a.tuned_artifacts || []).map(function (x) { return '<span class="pill">' + esc(x) + "</span>"; }).join("");
    var kers = (a.kernels || []).map(function (x) { return '<span class="pill">' + esc(x) + "</span>"; }).join("");
    return '<div class="block"><h3>AITER atom <span class="hint">the AMD kernel layer this config rides on</span></h3>' +
      '<div class="aiter"><div class="atop"><span class="lbl">AITER</span>' +
        '<span class="state ' + (a.enabled ? "on" : "off") + '">' + (a.enabled ? "enabled" : "off") + "</span>" +
        (a.commit ? '<span class="commit">@ ' + esc(a.commit) + "</span>" : "") + "</div>" +
        (a.summary ? '<div class="asum prose">' + prose(a.summary) + "</div>" : "") +
        '<div class="arows">' +
          (arts ? '<div class="arow"><span class="ak">tuned artifacts</span><span>' + arts + "</span></div>" : "") +
          (kers ? '<div class="arow"><span class="ak">kernels</span><span>' + kers + "</span></div>" : "") +
        "</div></div></div>";
  }

  function envBlock(env) {
    if (!env || !env.length) return "";
    var rows = env.map(function (e) {
      return "<tr><td class='kv'><span class='ek'>" + esc(e.key) + "</span>=<span class='ev'>" + esc(e.value) +
        "</span></td><td class='why prose'>" + prose(e.why || "") + "</td></tr>";
    }).join("");
    return '<div class="block"><h3>Container environment <span class="hint">runtime toggles</span></h3>' +
      '<table class="envtable"><thead><tr><th>variable</th><th>why</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }

  // decode_tok_s is a PER-STREAM rate (1000/TPOT), so it is only meaningful at
  // concurrency 1 and is left blank above it. output_tok_s is the aggregate
  // generation throughput, which is the number that means something at a full batch.
  // Keeping them as separate columns is deliberate: collapsing them is how you end up
  // reading 9 tok/s and 7,892 tok/s off the same row.
  var BENCH_COLS = [
    { k: "ttft_ms", label: "TTFT ms", d: 0 },
    { k: "tpot_ms", label: "TPOT ms", d: 1 },
    { k: "prefill_tok_s", label: "prefill tok/s", d: 0 },
    { k: "decode_tok_s", label: "decode tok/s", d: 1, hl: true },
    { k: "output_tok_s", label: "output tok/s", d: 1 },
    { k: "total_tok_s", label: "total tok/s", d: 1 },
    { k: "tok_s_per_gpu", label: "tok/s/GPU", d: 1 }
  ];
  function benchBlock(cfg) {
    var b = cfg.benchmarks || [];
    if (!b.length) return "";
    var cols = BENCH_COLS.filter(function (c) {
      return b.some(function (r) { return r[c.k] != null; });
    });
    var head = "<th>ISL / OSL</th><th>conc</th>" + cols.map(function (c) { return "<th>" + esc(c.label) + "</th>"; }).join("");
    var rows = b.map(function (r) {
      return "<tr><td>" + fmt(r.isl, 0) + " / " + fmt(r.osl, 0) + "</td>" +
        "<td>" + (r.concurrency == null ? "—" : fmt(r.concurrency, 0)) + "</td>" +
        cols.map(function (c) {
          return "<td" + (c.hl ? " class='hl'" : "") + ">" + (r[c.k] == null ? "—" : fmt(r[c.k], c.d)) + "</td>";
        }).join("") + "</tr>";
    }).join("");
    return '<div class="block"><h3>Measured performance <span class="hint">verified runs only · source-traced</span></h3>' +
      '<div class="dtable-scroll"><table class="dtable"><thead><tr>' + head + "</tr></thead><tbody>" + rows + "</tbody></table>" +
      "<caption><b>decode tok/s</b> is a single stream's steady-state rate (1000/TPOT), so it is " +
      "only meaningful at concurrency 1 and is left blank above it — read TPOT instead. " +
      "<b>output tok/s</b> is aggregate generation across the batch; <b>total tok/s</b> adds input " +
      "tokens, so it is the one to compare against prefill-heavy published figures. A blank cell " +
      "means the quantity was not measured for that row, never that it measured zero." +
      "</caption></div></div>";
  }

  function nvBlock(cfg) {
    var n = cfg.vs_nvidia || [];
    if (!n.length) return "";
    var rows = n.map(function (r) {
      var isAMD = /MI3/.test(r.hw);
      return "<tr" + (isAMD ? "" : ' class="nv"') + ">" +
        "<td>" + esc(r.hw) + (r.speculative ? " <small>(" + esc(r.speculative) + ")</small>" : "") + "</td>" +
        "<td>" + esc(r.strategy || "—") + "</td>" +
        "<td>" + (r.concurrency == null ? "—" : fmt(r.concurrency, 0)) + "</td>" +
        "<td>" + (r.ttft_ms == null ? "—" : fmt(r.ttft_ms, 0)) + "</td>" +
        "<td>" + (r.tpot_ms == null ? "—" : fmt(r.tpot_ms, 1)) + "</td>" +
        "<td>" + (r.tok_s_per_gpu == null ? "—" : fmt(r.tok_s_per_gpu, 0)) + "</td>" +
        "</tr>";
    }).join("");
    return '<div class="block"><h3>vs NVIDIA <span class="hint">SGLang cookbook reference · not always apples-to-apples</span></h3>' +
      '<div class="dtable-scroll"><table class="dtable"><thead><tr>' +
      "<th>hardware</th><th>strategy</th><th>conc</th><th>TTFT ms</th><th>TPOT ms</th><th>tok/s/GPU</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table>" +
      "<caption>AMD rows measured here; NVIDIA rows from the SGLang cookbook. Check the speculative-decoding note per row before reading these as apples-to-apples.</caption></div></div>";
  }

  function accBlock(acc) {
    if (!acc || !acc.length) return "";
    var items = acc.map(function (a) {
      return '<div class="accitem"><div class="an">' + esc(a.name) + '</div><div class="av">' + esc(a.value) + "</div>" +
        (a.ref ? '<div class="ar">ref ' + esc(a.ref) + "</div>" : "") +
        (a.note ? '<div class="anote prose">' + prose(a.note) + "</div>" : "") + "</div>";
    }).join("");
    return '<div class="block"><h3>Accuracy <span class="hint">correctness check on AMD</span></h3><div class="acc">' + items + "</div></div>";
  }

  function gotchaBlock(g) {
    if (!g || !g.length) return "";
    var items = g.map(function (x) { return '<li class="prose">' + prose(x) + "</li>"; }).join("");
    return '<div class="block"><h3>Gotchas <span class="hint">learned the hard way</span></h3><ul class="gotchas">' + items + "</ul></div>";
  }

  function provBlock(p) {
    if (!p) return "";
    var rows = [];
    function add(k, v) { if (v) rows.push('<div class="row"><dt>' + esc(k) + "</dt><dd>" + esc(v) + "</dd></div>"); }
    add("image", p.image); add("sglang", p.sglang); add("aiter", p.aiter);
    add("rocm", p.rocm); add("pr", p.pr); add("date", p.date); add("node", p.node);
    if (!rows.length) return "";
    return '<div class="block"><div class="prov"><div class="pe">measured under</div><dl>' + rows.join("") + "</dl></div></div>";
  }

  function emptyState(model) {
    var fv = firstVerified(model);
    var near = fv ? "Closest verified config: " + fv.gfx + " · " + fv.strategy : "No verified config yet.";
    var issue = "https://github.com/jhinpan/sglang-amd-cookbook/issues/new?title=" +
      encodeURIComponent("[bench] " + model.name + " · " + state.gfx + " · " + state.strategy);
    return '<div class="rc-head"><div class="rc-title"><span class="name">' + esc(model.name) + "</span>" +
      '<span class="hf">↳ ' + esc(model.hf_path) + "</span></div>" +
      '<div class="rc-chips"><span class="chip gfx">' + esc(state.gfx) + " · " + esc(GFXNAME[state.gfx]) + "</span>" +
      '<span class="chip">' + esc(state.strategy) + "</span>" + statusBadge("not_benchmarked") + "</div></div>" +
      '<div class="empty"><div class="big">Not yet benchmarked</div>' +
      '<div class="sub">This ' + esc(state.gfx) + " · " + esc(state.strategy) + " cell hasn't been measured. We publish verified numbers only.</div>" +
      '<div class="near">' + esc(near) + "</div>" +
      '<a class="cta" href="' + issue + '">Ran this config? Contribute numbers →</a></div>';
  }

  // ---------------------------------------------------------------- interactions
  function wireCopy(scope) {
    scope.querySelectorAll("[data-copy]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pre = btn.closest("[data-cmd]").querySelector("pre");
        var text = pre.innerText.replace(/ /g, " ");
        var done = function () { btn.textContent = "Copied"; btn.classList.add("copied");
          setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
          ta.select(); try { document.execCommand("copy"); } catch (e) {} document.body.removeChild(ta); done(); }
      });
    });
  }

  function revealGauges(scope) {
    var fills = scope.querySelectorAll(".fill");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      fills.forEach(function (f) { f.style.width = f.dataset.w + "%"; });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.style.width = e.target.dataset.w + "%"; io.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    fills.forEach(function (f) { io.observe(f); });
  }

  // ---------------------------------------------------------------- references (data-driven bits)
  function renderRefs() {
    var mhost = byId("refs-models");
    if (mhost) {
      mhost.innerHTML = MODELS.map(function (m) {
        return '<li><span class="arrow">→</span> <a href="https://huggingface.co/' + esc(m.hf_path) + '">' + esc(m.name) + "</a></li>";
      }).join("");
    }
    var shost = byId("refs-sglang");
    if (shost) {
      var prs = {};
      MODELS.forEach(function (m) {
        (m.configs || []).forEach(function (c) {
          if (c.provenance && c.provenance.pr) prs[c.provenance.pr] = true;
        });
      });
      var items = ['<li><span class="arrow">→</span> <a href="https://github.com/sgl-project/sglang">sgl-project/sglang</a></li>'];
      Object.keys(prs).forEach(function (pr) {
        var num = (pr.match(/\d+/) || [])[0];
        if (num) items.push('<li><span class="arrow">→</span> <a href="https://github.com/sgl-project/sglang/pull/' + num + '">PR #' + esc(num) + "</a></li>");
      });
      shost.innerHTML = items.join("");
    }
  }

  // ---------------------------------------------------------------- roadmap (what's missing)
  function renderRoadmap() {
    var host = byId("roadmap-body");
    if (!host) return;
    host.innerHTML = MODELS.map(function (m) {
      var gaps = m.gaps || [];
      var rows = gaps.map(function (g) {
        var cmd = g.cmd
          ? '<div class="cmd" data-cmd><div class="cmd-bar"><span class="tag">run on a live server</span>' +
            '<button class="copy-btn" data-copy>Copy</button></div><pre><code>' + tokenizeCmd(g.cmd) + "</code></pre></div>"
          : '<p class="gap-dep">↳ upstream dependency — no AMD script yet</p>';
        return '<div class="gap"><div class="gap-h"><span class="gap-kind ' + esc(g.kind) + '">' + esc(g.kind) + "</span>" +
          '<span class="gap-t">' + esc(g.title) + "</span></div>" +
          '<p class="gap-note prose">' + prose(g.note) + "</p>" + cmd + "</div>";
      }).join("");
      return '<div class="rm-card"><div class="rm-head"><span class="rm-name">' + esc(m.name) + "</span>" +
        '<span class="rm-count">' + gaps.length + " open</span></div>" + rows + "</div>";
    }).join("");
    wireCopy(host);
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (!MODELS.length) {
      byId("recipe").innerHTML = '<div class="empty"><div class="big">No data loaded</div><div class="sub">models.js did not populate window.MODELS.</div></div>';
      return;
    }
    renderHW();
    renderTabs();
    renderCompare();
    renderRefs();
    renderRoadmap();
    wireCopy(document);          // prerequisite command blocks
    var deep = parseHash();
    var startId = (deep.model && MODELS.some(function (m) { return m.id === deep.model; }))
      ? deep.model : MODELS[0].id;
    selectModel(startId, deep);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
