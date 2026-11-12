// AzureScraper UI: a tiny hash router, no framework.
//   #/                     -> category tiles
//   #/c/groceries          -> module tiles inside a category
//   #/c/groceries/kroger   -> module page (store picker + product search)

const view = document.getElementById("view");
const crumbs = document.getElementById("crumbs");

const STATUS_LABEL = { ready: "Ready", "needs-config": "Needs API key", planned: "Planned" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const money = (n) => (typeof n === "number" ? `$${n.toFixed(2)}` : "—");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `Request failed (${res.status})`);
  return body;
}

// localStorage can be unavailable; never let it break the page.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

function setCrumbs(parts) {
  crumbs.innerHTML = parts
    .map((p, i) => (i < parts.length - 1 && p.href ? `<a href="${p.href}">${esc(p.label)}</a>` : esc(p.label)))
    .join('<span class="sep">/</span>');
}

/* ---------- Home: category tiles ---------- */
async function renderHome() {
  setCrumbs([]);
  const cats = await api("/api/categories");
  view.innerHTML = `
    <h1>Categories</h1>
    <p class="sub">Pick a category to see its scraper modules.</p>
    <div class="tiles">
      ${cats.map((c) => `
        <a class="tile" href="#/c/${c.id}">
          <div class="tile-icon">${c.icon}</div>
          <div>
            <div class="tile-name">${esc(c.name)}</div>
            <div class="tile-desc">${esc(c.description)}</div>
          </div>
          <div class="tile-foot">
            <span>${c.moduleCount} modules</span>
            <span>${c.readyCount} ready</span>
          </div>
        </a>`).join("")}
    </div>`;
}

/* ---------- Category: module tiles ---------- */
async function renderCategory(catId) {
  const cat = await api(`/api/categories/${catId}`);
  setCrumbs([{ label: "Home", href: "#/" }, { label: cat.name }]);
  view.innerHTML = `
    <h1>${cat.icon} ${esc(cat.name)}</h1>
    <p class="sub">${esc(cat.description)}</p>
    <div class="tiles">
      ${cat.modules.map((m) => {
        const open = m.status !== "planned";
        const tag = open ? `a href="#/c/${cat.id}/${m.id}"` : "div";
        return `
        <${tag} class="tile ${open ? "" : "disabled"}">
          <div class="tile-letter">${esc(m.name[0])}</div>
          <div>
            <div class="tile-name">${esc(m.name)}</div>
            <div class="tile-desc">${esc(m.method)}</div>
          </div>
          <div class="tile-foot"><span class="pill ${m.status}">${STATUS_LABEL[m.status]}</span></div>
        </${open ? "a" : "div"}>`;
      }).join("")}
    </div>`;
}

/* ---------- Module page ---------- */
async function renderModule(catId, modId) {
  const [cat, mod, db] = await Promise.all([
    api(`/api/categories/${catId}`),
    api(`/api/categories/${catId}/modules/${modId}`),
    api("/api/db/status").catch(() => ({ configured: false })),
  ]);
  setCrumbs([{ label: "Home", href: "#/" }, { label: cat.name, href: `#/c/${catId}` }, { label: mod.name }]);

  const base = `/api/categories/${catId}/modules/${modId}`;
  const locKey = `azs.${modId}.location`;

  if (mod.status === "needs-config") {
    view.innerHTML = `
      <h1>${esc(mod.name)} <span class="pill needs-config">${STATUS_LABEL[mod.status]}</span></h1>
      <p class="sub">${esc(mod.description)}</p>
      <div class="panel">
        <h2>Setup needed</h2>
        <p class="notice">Add your ${esc(mod.name)} API keys in
        <a href="#/settings/connections" style="color:var(--azure)">Settings → Connections</a>.</p>
      </div>`;
    return;
  }

  view.innerHTML = `
    <h1>${esc(mod.name)} <span class="pill ${mod.status}">${STATUS_LABEL[mod.status]}</span></h1>
    <p class="sub">${esc(mod.description)} · <span class="meta">${esc(mod.method)}</span></p>

    ${mod.canFindLocations ? `
    <div class="panel">
      <h2>1. Pick a store <span class="meta">(prices are per store)</span></h2>
      <div class="row">
        <input id="zip" placeholder="ZIP code" maxlength="5" inputmode="numeric" style="width:130px" />
        <button id="findStores">Find stores</button>
        <select id="location"><option value="">— no store selected —</option></select>
      </div>
      <div id="locError" class="error"></div>
    </div>` : ""}

    <div class="panel">
      <h2>${mod.canFindLocations ? "2. " : ""}Search products</h2>
      <form id="searchForm" class="row">
        <input id="q" class="grow" placeholder="e.g. milk, eggs, coffee" />
        <button type="submit">Search</button>
      </form>
      <div id="searchMeta" class="meta" style="margin-top:10px"></div>
      <div id="searchError" class="error"></div>
      ${mod.canSave ? `
      <div class="save-bar">
        <button id="saveAll" class="ghost" disabled>Save all to database</button>
        <span id="saveMsg" class="meta">${db.configured
          ? `Saves to table <code>${esc(db.table)}</code>`
          : `Database not set up. Add PostgreSQL in <a href="#/settings/connections" style="color:var(--azure)">Settings → Connections</a>.`}</span>
      </div>` : ""}
    </div>

    <div id="bulk"></div>

    <div id="results" class="products"></div>`;

  const sel = document.getElementById("location");
  mountBulk(document.getElementById("bulk"), base, sel).catch(() => {});

  // Restore the last-picked store.
  const saved = store.get(locKey);
  if (sel && saved) {
    const { id, label } = JSON.parse(saved);
    sel.innerHTML += `<option value="${esc(id)}" selected>${esc(label)}</option>`;
  }
  sel?.addEventListener("change", () => {
    const opt = sel.selectedOptions[0];
    store.set(locKey, JSON.stringify({ id: sel.value, label: opt.textContent }));
  });

  document.getElementById("findStores")?.addEventListener("click", async () => {
    const zip = document.getElementById("zip").value.trim();
    const err = document.getElementById("locError");
    err.textContent = "";
    try {
      const locs = await api(`${base}/locations?zip=${encodeURIComponent(zip)}`);
      sel.innerHTML = locs.length
        ? locs.map((l) => `<option value="${esc(l.locationId)}">${esc(l.name)} — ${esc(l.address)}</option>`).join("")
        : `<option value="">No stores found</option>`;
      sel.dispatchEvent(new Event("change"));
    } catch (e) { err.textContent = e.message; }
  });

  document.getElementById("searchForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = document.getElementById("q").value.trim();
    const err = document.getElementById("searchError");
    const meta = document.getElementById("searchMeta");
    const results = document.getElementById("results");
    err.textContent = "";
    meta.textContent = "Searching…";
    try {
      const params = new URLSearchParams({ q });
      if (sel?.value) params.set("locationId", sel.value);
      const items = await api(`${base}/search?${params}`);
      lastItems = items;
      meta.textContent = `${items.length} results${sel?.value ? "" : " · pick a store to see prices"}`;
      results.innerHTML = items.map((p) => productCard(p, { canSave: mod.canSave, dbReady: db.configured, base, locationId: sel?.value })).join("");
      const saveAll = document.getElementById("saveAll");
      if (saveAll) saveAll.disabled = !db.configured || !items.length;
      refreshSaved();
    } catch (e) { meta.textContent = ""; err.textContent = e.message; }
  });

  /* ----- Saving to the database ----- */
  let lastItems = [];
  const results = document.getElementById("results");

  function markSaved(ids) {
    for (const id of ids) {
      const btn = results.querySelector(`[data-save="${CSS.escape(id)}"]`);
      if (btn) { btn.textContent = "✓ In database"; btn.classList.add("saved"); }
    }
  }

  async function refreshSaved() {
    if (!mod.canSave || !db.configured || !lastItems.length) return;
    const r = await api(`${base}/saved`, { method: "POST", body: { productIds: lastItems.map((p) => p.productId) } }).catch(() => null);
    if (r?.saved) markSaved(r.saved);
  }

  async function save(ids, btns) {
    const msg = document.getElementById("saveMsg");
    btns.forEach((b) => { b.disabled = true; b.dataset.label = b.textContent; b.textContent = "Saving…"; });
    try {
      const r = await api(`${base}/save`, { method: "POST", body: { productIds: ids, locationId: sel?.value || undefined } });
      markSaved(r.saved);
      const parts = [`Saved ${r.saved.length} item${r.saved.length === 1 ? "" : "s"}`];
      if (r.saved.length) parts.push(`${r.withNutrition} with nutrition facts, ${r.withIngredients} with ingredients`);
      if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed[0].error}`);
      msg.className = r.failed.length ? "result bad" : "result ok";
      msg.textContent = parts.join(" · ");
    } catch (e) {
      msg.className = "result bad"; msg.textContent = e.message;
    } finally {
      btns.forEach((b) => { b.disabled = false; if (!b.classList.contains("saved")) b.textContent = b.dataset.label; });
    }
  }

  results.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-save]");
    if (btn) save([btn.dataset.save], [btn]);
  });

  document.getElementById("saveAll")?.addEventListener("click", (e) => {
    save(lastItems.map((p) => p.productId), [e.currentTarget]);
  });
}

function productCard(p, { canSave, dbReady, base, locationId } = {}) {
  const rawUrl = base ? `${base}/raw/${encodeURIComponent(p.productId)}${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ""}` : "";
  const onSale = typeof p.promoPrice === "number" && p.promoPrice < (p.price ?? Infinity);
  return `
    <div class="product">
      <div class="product-img">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" />` : ""}</div>
      <div class="product-body">
        <div class="product-brand">${esc(p.brand)}</div>
        <div class="product-name">${esc(p.name)}</div>
        <div class="product-size">${esc(p.size)}${p.aisle ? ` · ${esc(p.aisle)}` : ""}</div>
        <div class="price">
          ${onSale
            ? `<span class="sale">${money(p.promoPrice)}</span><span class="was">${money(p.price)}</span>`
            : money(p.price)}
        </div>
        <div class="card-links">
          ${p.url ? `<a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">View on site ↗</a>` : ""}
          ${rawUrl ? `<a class="link muted" href="${esc(rawUrl)}" target="_blank" rel="noopener" title="Raw API data">Raw</a>` : ""}
        </div>
        ${canSave ? `<button class="ghost small save-btn" data-save="${esc(p.productId)}" ${dbReady ? "" : "disabled"}>Save to database</button>` : ""}
      </div>
    </div>`;
}

/* ---------- Bulk tools: crawl + price update ---------- */
const STAT_LABEL = {
  found: "found", new: "new", updated: "updated", priced: "priced", unpriced: "no price",
  pricePoints: "price points", calls: "API calls", errors: "errors",
};

function statChips(stats = {}) {
  return Object.entries(stats)
    .map(([k, v]) => `<span class="chip">${esc(v.toLocaleString())} ${esc(STAT_LABEL[k] ?? k)}</span>`)
    .join("");
}

function lastRunLine(run) {
  if (!run) return `<span class="meta">Never run</span>`;
  const when = run.finishedAt ? new Date(run.finishedAt).toLocaleString() : "";
  const cls = run.status === "failed" ? "bad" : run.status === "done" ? "ok" : "";
  return `<span class="meta">Last run ${esc(when)} · </span><span class="result ${cls}">${esc(run.message ?? run.status)}</span>
    <div class="chips">${statChips(run.stats)}</div>`;
}

async function mountBulk(holder, base, sel) {
  const render = async () => {
    if (!holder.isConnected) return; // navigated away
    const s = await api(`${base}/jobs`);
    if (!s.canCrawl && !s.canUpdatePrices) { holder.innerHTML = ""; return; }
    const running = s.current?.status === "running" ? s.current : null;
    const c = s.crawl;
    const crawlCalls = c ? c.terms.length * c.pagesPerTerm : 0;
    const priceCalls = s.savedCount ? Math.ceil(s.savedCount / 50) : 0;

    holder.innerHTML = `
      <div class="panel">
        <h2>3. Bulk tools <span class="meta">(run in the background, stop at the daily API budget)</span></h2>
        <div class="meta" style="margin-bottom:14px">
          ${s.usage ? `API calls today: <b>${s.usage.used.toLocaleString()}</b> / ${s.usage.budget.toLocaleString()} budget` : ""}
          ${s.savedCount !== null ? ` · <b>${s.savedCount.toLocaleString()}</b> items in database` : ""}
          ${s.dbConfigured ? "" : ` · <a href="#/settings/connections" style="color:var(--azure)">Add PostgreSQL</a> to use these tools`}
        </div>

        <div class="bulk-grid">
          ${s.canCrawl ? `
          <div class="bulk-card">
            <h3>Crawl catalog</h3>
            <p class="meta">Searches every term in the list at the store picked above and saves all results.
              Up to <b>${crawlCalls.toLocaleString()}</b> calls, up to <b>${(crawlCalls * c.pageSize).toLocaleString()}</b> products.</p>
            <div class="row">
              <label class="meta">Pages per term
                <select id="pages" style="min-width:auto;margin-left:6px">
                  ${Array.from({ length: c.maxPages }, (_, i) => `<option ${i + 1 === c.pagesPerTerm ? "selected" : ""}>${i + 1}</option>`).join("")}
                </select>
              </label>
              <button class="ghost small" id="editTerms">Edit terms (${c.terms.length})</button>
            </div>
            <div id="termsBox" hidden>
              <textarea id="terms" rows="10" spellcheck="false">${esc(c.terms.join("\n"))}</textarea>
              <div class="actions"><button class="small" id="saveTerms">Save terms</button>
                <span class="meta">One search term or brand per line.</span></div>
            </div>
            <div class="actions">
              <button id="startCrawl" ${running || !s.dbConfigured ? "disabled" : ""}>Start crawl</button>
            </div>
            <div class="last">${lastRunLine(s.last.crawl)}</div>
          </div>` : ""}

          ${s.canUpdatePrices ? `
          <div class="bulk-card">
            <h3>Update prices</h3>
            <p class="meta">Refreshes the price of every saved item at the store it was saved from and adds
              today's point to the price history. About <b>${priceCalls.toLocaleString()}</b> calls.</p>
            <label class="check"><input type="checkbox" id="priceOverride" /> Use the store picked above for all items</label>
            <div class="actions">
              <button id="startPrices" ${running || !s.dbConfigured || !s.savedCount ? "disabled" : ""}>Update prices</button>
            </div>
            <div class="last">${lastRunLine(s.last.prices)}</div>
          </div>` : ""}
        </div>

        ${s.current ? `
        <div class="job ${s.current.status}">
          <div class="job-head">
            <b>${s.current.type === "crawl" ? "Crawl" : "Price update"}</b>
            <span class="pill ${s.current.status === "running" ? "ready" : s.current.status === "failed" ? "needs-config" : "planned"}">${esc(s.current.status)}</span>
            <span class="meta">${s.current.progress.done.toLocaleString()} / ${s.current.progress.total.toLocaleString()}</span>
            ${running ? `<button class="danger small" id="cancelJob">Cancel</button>` : ""}
          </div>
          <div class="bar"><div style="width:${s.current.progress.total ? Math.round((100 * s.current.progress.done) / s.current.progress.total) : 0}%"></div></div>
          <div class="chips">${statChips(s.current.stats)}</div>
          ${s.current.message ? `<div class="result ${s.current.status === "failed" ? "bad" : "ok"}">${esc(s.current.message)}</div>` : ""}
          <pre class="log">${esc(s.current.log.slice(-12).join("\n"))}</pre>
        </div>` : ""}
        <div id="bulkError" class="error"></div>
      </div>`;

    const err = holder.querySelector("#bulkError");
    const guard = (fn) => async (e) => {
      err.textContent = "";
      try { await fn(e); } catch (x) { err.textContent = x.message; }
    };
    const saveSettings = () => api(`${base}/crawl-settings`, {
      method: "PUT",
      body: {
        terms: holder.querySelector("#terms").value.split("\n"),
        pagesPerTerm: Number(holder.querySelector("#pages").value),
      },
    });

    holder.querySelector("#editTerms")?.addEventListener("click", () => {
      const box = holder.querySelector("#termsBox");
      box.hidden = !box.hidden;
    });
    holder.querySelector("#saveTerms")?.addEventListener("click", guard(async () => { await saveSettings(); await render(); }));
    holder.querySelector("#pages")?.addEventListener("change", guard(async () => { await saveSettings(); await render(); }));
    holder.querySelector("#startCrawl")?.addEventListener("click", guard(async () => {
      if (!sel?.value) throw new Error("Pick a store in step 1 first: prices are per store.");
      await api(`${base}/jobs/crawl`, { method: "POST", body: { locationId: sel.value } });
      await render();
    }));
    holder.querySelector("#startPrices")?.addEventListener("click", guard(async () => {
      const override = holder.querySelector("#priceOverride").checked;
      if (override && !sel?.value) throw new Error("Pick a store in step 1 first.");
      await api(`${base}/jobs/prices`, { method: "POST", body: { locationId: override ? sel.value : undefined } });
      await render();
    }));
    holder.querySelector("#cancelJob")?.addEventListener("click", guard(async () => {
      await api(`/api/jobs/${s.current.id}/cancel`, { method: "POST" });
    }));

    clearTimeout(holder._poll);
    if (running) holder._poll = setTimeout(render, 1500);
  };
  await render();
}

/* ---------- Settings ---------- */
const SETTINGS_PAGES = [
  { id: "general", label: "General", wip: true },
  { id: "connections", label: "Connections" },
];

async function renderSettings(page) {
  const current = SETTINGS_PAGES.find((p) => p.id === page && !p.wip) ? page : "connections";
  setCrumbs([{ label: "Home", href: "#/" }, { label: "Settings" }]);
  view.innerHTML = `
    <div class="settings">
      <nav class="side-nav">
        ${SETTINGS_PAGES.map((p) => p.wip
          ? `<span>${p.label} <small>WIP</small></span>`
          : `<a href="#/settings/${p.id}" class="${p.id === current ? "active" : ""}">${p.label}</a>`).join("")}
      </nav>
      <section id="settingsBody"></section>
    </div>`;
  if (current === "connections") await renderConnections(document.getElementById("settingsBody"));
}

/* ---------- Settings > Connections ---------- */
async function renderConnections(root) {
  const [providers, { connections, envOnly }] = await Promise.all([
    api("/api/connections/providers"),
    api("/api/connections"),
  ]);
  const byId = Object.fromEntries(providers.map((p) => [p.id, p]));
  const savedIds = new Set(connections.map((c) => c.id));
  const addable = providers.filter((p) => !savedIds.has(p.id));

  // Group the dropdown by category (Groceries, ...), Custom at the end.
  const groups = {};
  for (const p of addable) (groups[p.category] ??= []).push(p);

  root.innerHTML = `
    <h1>Connections</h1>
    <p class="sub">API keys and credentials used by scraper modules. Secrets are stored on the server and never shown again.</p>

    <div class="panel">
      <h2>Add connection</h2>
      <div class="row">
        <select id="addSelect">
          <option value="">Choose a service…</option>
          ${Object.entries(groups).map(([cat, list]) => `
            <optgroup label="${esc(cat)}">
              ${list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}
            </optgroup>`).join("")}
          <optgroup label="Other"><option value="custom">Custom API…</option></optgroup>
        </select>
      </div>
      <div id="addForm"></div>
    </div>

    ${envOnly.length ? `<p class="notice" style="margin:-4px 0 18px">
      ${envOnly.map((e) => esc(e.name)).join(", ")} ${envOnly.length > 1 ? "are" : "is"} currently configured from
      environment variables. Adding it here will take priority.</p>` : ""}

    <div class="panel">
      <h2>Saved connections</h2>
      <div class="conn-list">
        ${connections.length ? connections.map((c) => connCard(c, byId[c.providerId])).join("") : `<div class="empty">No connections yet.</div>`}
      </div>
    </div>`;

  const reload = () => renderConnections(root);

  document.getElementById("addSelect").addEventListener("change", (e) => {
    const holder = document.getElementById("addForm");
    const id = e.target.value;
    holder.innerHTML = "";
    if (!id) return;
    mountConnForm(holder, { provider: id === "custom" ? null : byId[id], existing: null, onDone: reload });
  });

  root.querySelectorAll(".conn").forEach((card) => {
    const conn = connections.find((c) => c.id === card.dataset.id);
    const provider = byId[conn.providerId] ?? null;
    const out = card.querySelector(".result");

    card.querySelector("[data-act=edit]").addEventListener("click", () => {
      const slot = card.querySelector(".conn-edit");
      if (slot.childElementCount) { slot.innerHTML = ""; slot.hidden = true; return; }
      slot.hidden = false;
      mountConnForm(slot, { provider, existing: conn, onDone: reload });
    });
    card.querySelector("[data-act=test]")?.addEventListener("click", async () => {
      out.className = "result"; out.textContent = "Testing…";
      const r = await api("/api/connections/test", { method: "POST", body: { providerId: conn.providerId } });
      out.className = `result ${r.ok ? "ok" : "bad"}`; out.textContent = r.message;
    });
    card.querySelector("[data-act=toggle]").addEventListener("change", async (e) => {
      await api(`/api/connections/${conn.id}`, { method: "PUT", body: { enabled: e.target.checked } });
      reload();
    });
    card.querySelector("[data-act=delete]").addEventListener("click", async () => {
      if (!confirm(`Delete the "${conn.name}" connection? Its saved keys will be removed.`)) return;
      await api(`/api/connections/${conn.id}`, { method: "DELETE" });
      reload();
    });
  });
}

function connCard(c, provider) {
  const label = (key) => provider?.fields.find((f) => f.key === key)?.label ?? key;
  return `
    <div class="conn" data-id="${esc(c.id)}">
      <div>
        <div class="conn-title">${esc(c.name)}
          <span class="pill ${c.enabled ? "ready" : "off"}">${c.enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <div class="meta">${esc(c.providerName)} · updated ${new Date(c.updatedAt).toLocaleString()}</div>
      </div>
      <div class="actions">
        <label class="check"><input type="checkbox" data-act="toggle" ${c.enabled ? "checked" : ""}/> On</label>
        ${c.canTest ? `<button class="ghost small" data-act="test">Test</button>` : ""}
        <button class="ghost small" data-act="edit">Edit</button>
        <button class="danger small" data-act="delete">Delete</button>
      </div>
      <div class="conn-fields">
        ${c.fields.map((f) => `<span>${esc(label(f.key))}: <b>${f.isSet ? esc(f.preview ?? f.value) : "—"}</b></span>`).join("")}
        <span class="result"></span>
      </div>
      <div class="conn-edit" hidden></div>
    </div>`;
}

/**
 * Renders the form for a provider (fields come from the server definition)
 * or for a Custom API (name + any number of key/value rows).
 */
function mountConnForm(holder, { provider, existing, onDone }) {
  const isCustom = !provider;
  const savedField = (key) => existing?.fields.find((f) => f.key === key);

  const providerFields = () => provider.fields.map((f) => {
    const s = savedField(f.key);
    const keepHint = f.type === "secret" && s?.isSet ? `Saved (${s.preview}). Leave blank to keep.` : (f.placeholder ?? "");
    return `
      <div class="field">
        <label for="f_${f.key}">${esc(f.label)}${f.required ? '<span class="req">*</span>' : ""}</label>
        <input id="f_${f.key}" data-key="${esc(f.key)}" type="${f.type === "secret" ? "password" : "text"}"
               autocomplete="off" placeholder="${esc(keepHint)}"
               value="${f.type === "secret" ? "" : esc(s?.value ?? "")}" />
        ${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}
      </div>`;
  }).join("");

  const kvRow = (key = "", preview = "") => `
    <div class="kv-row">
      <input class="kv-key" placeholder="Key name (e.g. API_KEY)" value="${esc(key)}" />
      <input class="kv-val" type="password" autocomplete="off"
             placeholder="${preview ? `Saved (${esc(preview)}). Leave blank to keep.` : "Value"}" />
      <button type="button" class="ghost small kv-del" title="Remove">✕</button>
    </div>`;

  holder.innerHTML = `
    <form class="form-grid" autocomplete="off">
      ${provider ? `<p class="notice" style="margin:0">${esc(provider.description)}
        ${provider.docsUrl ? ` <a href="${esc(provider.docsUrl)}" target="_blank" rel="noopener" style="color:var(--azure)">Get keys ↗</a>` : ""}</p>` : ""}
      ${isCustom ? `
        <div class="field">
          <label>Name<span class="req">*</span></label>
          <input id="c_name" placeholder="e.g. Spoonacular" value="${esc(existing?.name ?? "")}" />
        </div>
        <div class="field">
          <label>Fields</label>
          <div id="kvRows" class="form-grid" style="margin:0">
            ${existing ? existing.fields.map((f) => kvRow(f.key, f.preview)).join("") : kvRow("API_KEY")}
          </div>
          <button type="button" id="kvAdd" class="ghost small" style="margin-top:8px">+ Add field</button>
        </div>` : providerFields()}
      <label class="check"><input type="checkbox" id="c_enabled" ${existing?.enabled === false ? "" : "checked"} /> Enabled</label>
      <div class="actions">
        <button type="submit">${existing ? "Save changes" : "Save connection"}</button>
        ${provider?.canTest ? `<button type="button" class="ghost" id="c_test">Test</button>` : ""}
        <button type="button" class="ghost" id="c_cancel">Cancel</button>
        <span class="result" id="c_result"></span>
      </div>
    </form>`;

  const form = holder.querySelector("form");
  const out = holder.querySelector("#c_result");
  const show = (ok, msg) => { out.className = `result ${ok ? "ok" : "bad"}`; out.textContent = msg; };

  if (isCustom) {
    const rows = holder.querySelector("#kvRows");
    holder.querySelector("#kvAdd").addEventListener("click", () => rows.insertAdjacentHTML("beforeend", kvRow()));
    rows.addEventListener("click", (e) => { if (e.target.classList.contains("kv-del")) e.target.closest(".kv-row").remove(); });
  }

  const collect = () => {
    const values = {};
    if (isCustom) {
      holder.querySelectorAll(".kv-row").forEach((r) => {
        const k = r.querySelector(".kv-key").value.trim();
        if (k) values[k] = r.querySelector(".kv-val").value;
      });
    } else {
      holder.querySelectorAll("[data-key]").forEach((i) => { values[i.dataset.key] = i.value; });
    }
    return {
      providerId: isCustom ? "custom" : provider.id,
      name: isCustom ? holder.querySelector("#c_name").value : undefined,
      enabled: holder.querySelector("#c_enabled").checked,
      values,
    };
  };

  holder.querySelector("#c_test")?.addEventListener("click", async () => {
    out.className = "result"; out.textContent = "Testing…";
    const { providerId, values } = collect();
    const r = await api("/api/connections/test", { method: "POST", body: { providerId, values } });
    show(r.ok, r.message);
  });

  holder.querySelector("#c_cancel").addEventListener("click", () => {
    holder.innerHTML = "";
    if (holder.classList.contains("conn-edit")) holder.hidden = true;
    const sel = document.getElementById("addSelect");
    if (!existing && sel) sel.value = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const body = collect();
      if (existing) await api(`/api/connections/${existing.id}`, { method: "PUT", body });
      else await api("/api/connections", { method: "POST", body });
      onDone();
    } catch (err) { show(false, err.message); }
  });
}

/* ---------- Router ---------- */
async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  document.getElementById("settingsBtn").classList.toggle("active", parts[0] === "settings");
  try {
    if (parts[0] === "settings") await renderSettings(parts[1] || "connections");
    else if (parts[0] === "c" && parts[2]) await renderModule(parts[1], parts[2]);
    else if (parts[0] === "c" && parts[1]) await renderCategory(parts[1]);
    else await renderHome();
  } catch (e) {
    view.innerHTML = `<div class="panel"><div class="error">${esc(e.message)}</div></div>`;
  }
}

window.addEventListener("hashchange", route);
route();
