/* =========================
   CONFIG — fill these in
========================= */
const AIRTABLE_API_KEY = "pat6QyOfQCQ9InhK4.4b944a38ad4c503a6edd9361b2a6c1e7f02f216ff05605f7690d3adb12c94a3c";
const BASE_ID          = "appQDdkj6ydqUaUkE";
const TABLE_ID         = "tblg98QfBxRd6uivq"; // e.g., main backcharge/warranty table

// Field names in your base
const FIELD_JOB_NAME    = "Job Name";
const FIELD_GM_OUTCOME  = "GM/ACM Outcome"; // must match Airtable exactly
const FIELD_ID_NUMBER   = "ID Number";  // must match Airtable exactly

// Allowed values for GM Outcome edit control
const GM_OPTIONS = [
  "GM/ACM Approved",
  "GM/ACM Denied"
];

/* =========================
   STATE
========================= */
let allRecords = [];
const pendingSaves = new Map(); // recordId -> abortController

/* =========================
   FETCH
========================= */
async function fetchAll() {
  const out = [];
  let offset = null;

  do {
    let url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_ID)}?pageSize=100&filterByFormula={Approved or Dispute}="Dispute"`;
    if (offset) url += `&offset=${offset}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Airtable error ${res.status}: ${txt || res.statusText}`);
    }
    const data = await res.json();
    out.push(...data.records);
    offset = data.offset;
  } while (offset);

  allRecords = out.filter(r => r?.fields && (r.fields[FIELD_JOB_NAME] || r.fields[FIELD_GM_OUTCOME]));
}

/* =========================
   STATE (add this near top with other state)
========================= */
const lastSavedValue = new Map(); // recordId -> last successfully saved GM Outcome

/* =========================
   PATCH to Airtable (GM Outcome) — REPLACE YOUR FUNCTION WITH THIS
========================= */
async function patchOutcome(recordId, newValue) {
  // Cancel any in-flight save for this record
  const prev = pendingSaves.get(recordId);
  if (prev) prev.abort();

  const controller = new AbortController();
  pendingSaves.set(recordId, controller);

  try {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE_ID)}/${recordId}`;
    const body = JSON.stringify({ fields: { [FIELD_GM_OUTCOME]: newValue } });

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body,
      signal: controller.signal
    });

    const text = await res.text(); // read text so we can log/parse errors from Airtable
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`;
      try {
        const json = JSON.parse(text);
        if (json?.error?.message) errMsg += ` — ${json.error.message}`;
        if (json?.error?.type) errMsg += ` [${json.error.type}]`;
      } catch {
        if (text) errMsg += ` — ${text}`;
      }
      console.error("PATCH failed:", errMsg, { url, body });
      throw new Error(errMsg);
    }

    // Parse updated record
    const updated = JSON.parse(text);

    // Update local cache
    const idx = allRecords.findIndex(r => r.id === recordId);
    if (idx !== -1) allRecords[idx] = updated;

    // Remember last good value for this record
    lastSavedValue.set(recordId, updated.fields?.[FIELD_GM_OUTCOME] ?? "");

    return { ok: true };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, aborted: true };
    return { ok: false, error: err.message || String(err) };
  } finally {
    const cur = pendingSaves.get(recordId);
    if (cur === controller) pendingSaves.delete(recordId);
  }
}

/* =========================
   Save handler — REPLACE YOUR handleSave WITH THIS
========================= */
async function handleSave(selectEl, statusEl) {
  const recordId = selectEl.dataset.id;
  const value = selectEl.value;

  // If user didn’t actually change the value, don’t PATCH
  const currentInCache = allRecords.find(r => r.id === recordId)?.fields?.[FIELD_GM_OUTCOME] ?? "";
  if (String(currentInCache) === String(value)) {
    return;
  }

  statusEl.textContent = "Saving…";
  statusEl.className = "status saving";

  const { ok, error, aborted } = await patchOutcome(recordId, value);
  if (ok) {
    statusEl.textContent = "Saved";
    statusEl.className = "status saved";
  } else if (aborted) {
    // superseded by a newer save
  } else {
    statusEl.textContent = `Error: ${error || "Failed to save"}`;
    statusEl.className = "status error";

    // Revert UI to last saved value if we have one
    const last = lastSavedValue.get(recordId);
    if (last !== undefined) {
      selectEl.value = last;
    }
  }

  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "status muted";
  }, 1800);
}


/* =========================
   RENDER
========================= */
function render() {
  const container = document.getElementById("list");
  const countsEl  = document.getElementById("counts");
  const q = (document.getElementById("searchBar").value || "").trim().toLowerCase();

  let rows = [...allRecords];

 

  // Search by Job Name
  if (q) {
    rows = rows.filter(r => (r.fields[FIELD_JOB_NAME] ?? "").toString().toLowerCase().includes(q));
  }

  // Sort by outcome rank then job name
  rows.sort((a, b) => {
    const oa = rankOutcome(a.fields[FIELD_GM_OUTCOME]);
    const ob = rankOutcome(b.fields[FIELD_GM_OUTCOME]);
    if (oa !== ob) return oa - ob;
    return (a.fields[FIELD_JOB_NAME] ?? "").toString().localeCompare((b.fields[FIELD_JOB_NAME] ?? "").toString());
  });

  container.innerHTML = "";
  let approvedCount = 0, disputedCount = 0, otherCount = 0;

  rows.forEach(rec => {
    const job = (rec.fields[FIELD_JOB_NAME] ?? "").toString();
    const outcomeRaw = (rec.fields[FIELD_GM_OUTCOME] ?? "").toString().trim();
    const normalized = normalizeOutcome(outcomeRaw);

    if (normalized === "Approved") approvedCount++;
    else if (normalized === "Dispute" || normalized === "Disputed") disputedCount++;
    else otherCount++;

    const chipClass = normalized === "Approved" ? "chip ok" :
                      (normalized === "Dispute" || normalized === "Disputed") ? "chip no" : "chip";
    const safeOutcome = outcomeRaw || "(No outcome)";
    const idNum = rec.fields[FIELD_ID_NUMBER] ?? "(No ID)";

    // Build editable select for GM Outcome
    const selectId = `sel-${rec.id}`;
    const statusId = `sts-${rec.id}`;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <h3 class="job">${escapeHtml(job || "(No Job Name)")}</h3>

      <div class="row">
        <span class="${chipClass}">${escapeHtml(normalized || "(No outcome)")}</span>
        <span class="muted">ID Number: ${escapeHtml(idNum)}</span>
      </div>

      <div class="field">
        <label for="${selectId}" class="muted">GM Outcome:</label>
        <select class="select" id="${selectId}" data-id="${escapeHtml(rec.id)}">
          ${GM_OPTIONS.map(opt => `<option value="${escapeHtml(opt)}"${opt === outcomeRaw ? " selected" : ""}>${escapeHtml(opt)}</option>`).join("")}
        </select>
        <span id="${statusId}" class="status muted"></span>
      </div>
    `;

    container.appendChild(card);

    const selectEl = card.querySelector(`#${CSS.escape(selectId)}`);
    const statusEl = card.querySelector(`#${CSS.escape(statusId)}`);

    // Save on change
    selectEl.addEventListener("change", async () => {
      await handleSave(selectEl, statusEl);
      // Re-render chip to reflect normalized color
      render();
    });

    // Save on blur (off-click)
    selectEl.addEventListener("blur", async () => {
      await handleSave(selectEl, statusEl);
      render();
    });
  });

  countsEl.textContent = `Showing ${rows.length} record(s) — Approved: ${approvedCount} · Dispute/Disputed: ${disputedCount}${otherCount ? ` · Other/Blank: ${otherCount}` : ""}`;
}



/* =========================
   HELPERS
========================= */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}
function equalsIgnoreCase(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}
function normalizeOutcome(val) {
  const v = (val || "").toString().trim().toLowerCase();
  if (!v) return "";
  if (v === "approved" || v === "gm approved bc from builder") return "Approved";
  if (v === "dispute" || v === "disputed" || v === "gm denied bc from builder") return "Disputed";
  return val;
}
function rankOutcome(val) {
  const v = (val || "").toString().trim().toLowerCase();
  if (v === "approved" || v === "gm approved bc from builder") return 0;
  if (v === "dispute" || v === "disputed" || v === "gm denied bc from builder") return 1;
  return 2;
}

/* =========================
   URL SYNC
========================= */
function updateUrlWithSearch(query) {
  const url = new URL(window.location);
  if (query) {
    url.searchParams.set("job", query);
  } else {
    url.searchParams.delete("job");
  }
  window.history.replaceState({}, "", url);
}

/* =========================
   BOOT
========================= */
document.addEventListener("DOMContentLoaded", async () => {
  const searchBar = document.getElementById("searchBar");

  // If URL has ?job=..., populate the search bar
  const params = new URLSearchParams(window.location.search);
  const jobParam = params.get("job");
  if (jobParam) {
    searchBar.value = jobParam;
  }

  searchBar.addEventListener("input", () => {
    updateUrlWithSearch(searchBar.value.trim());
    render();
  });

  try {
    await fetchAll();
    render();
  } catch (e) {
    console.error(e);
    document.getElementById("list").innerHTML =
      `<div class="card"><div class="row"><span class="chip no">Error</span><span class="muted">${escapeHtml(e.message)}</span></div></div>`;
  }
});
