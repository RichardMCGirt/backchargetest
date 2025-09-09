/* =========================
   CONFIG / CONSTANTS
========================= */
const AIRTABLE_API_KEY = "pat6QyOfQCQ9InhK4.4b944a38ad4c503a6edd9361b2a6c1e7f02f216ff05605f7690d3adb12c94a3c";
const BASE_ID = "appQDdkj6ydqUaUkE";
const TABLE_ID = "tblg98QfBxRd6uivq";

const SUBCONTRACTOR_TABLE = "tblgsUP8po27WX7Hb"; // “Subcontractor Company Name”
const CUSTOMER_TABLE      = "tblQ7yvLoLKZlZ9yU"; // “Client Name”
const TECH_TABLE          = "tblj6Fp0rvN7QyjRv"; // “Full Name”
const BRANCH_TABLE        = "tblD2gLfkTtJYIhmK"; // “Office Name”
const VENDOR_TABLE        = "tblp77wpnsiIjJLGh"; // Vendor table used by "Vendor to backcharge"
const DEFAULT_VIEW_FOR_BG_CHECK = "viwTHoVVR3TsPDR6k";
let bgCountdownHandle = null;

const FILTER_BASE_FORMULA = `AND(
  {Type of Backcharge} = 'Builder Issued Backcharge',
  OR(
    {Approved or Dispute} = "",
    NOT({Approved or Dispute})
  )
)`;

// Cache & State
const recordCache = {};            
const tableRecords = {};
const FORCE_AUTOLOAD = true;
       
let allRecords = []; 
let activeTechFilter = null;
let activeBranchFilter = null;
let hasRestoredFilters = false;
let pendingDecision = null;
let pendingRecordId = null;
let pendingRecordName = null;
let pendingRecordIdNumber = null;
let lastActiveCardId = null;
let disputeFormContainer = null;
let disputeReasonInput = null;           
let disputeSubSelect = null;             
let disputeVendorSelect = null;          
let disputeAmountInput = null;           
let disputeVendorAmountInput = null;     
let disputeAmount2Input = null;
let disputeVendorDisplay = null;
let subReasonInput = null;       
let vendorReasonInput = null;    
let updateConditionalReasonsUI = null;

/* =========================
   UTIL / UI HELPERS
========================= */
function isBlank(v){ return v == null || (typeof v === "string" && v.trim() === ""); }
function recordMatchesScope(rec){
  const f = rec?.fields || {};
  return f["Type of Backcharge"] === "Builder Issued Backcharge"
      && isBlank(f["Approved or Dispute"]);
}

function startConsoleCountdown(durationMs) {
  stopConsoleCountdown();
  const pad = (n) => String(n).padStart(2, "0");
  const end = Date.now() + Math.max(0, durationMs);

  const print = () => {
    const remaining = Math.max(0, end - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const mm = Math.floor(totalSec / 60);
    const ss = totalSec % 60;
    if (remaining <= 0) stopConsoleCountdown();
  };

  print(); // log immediately
  bgCountdownHandle = setInterval(print, 1000);
}

function stopConsoleCountdown() {
  if (bgCountdownHandle) {
    clearInterval(bgCountdownHandle);
    bgCountdownHandle = null;
  }
}

function looksLikeLinkedIds(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const recPattern = /^rec[A-Za-z0-9]{14}$/;
  return arr.every(v => typeof v === "string" && recPattern.test(v));
}
function asLinkedIds(val) {
  return Array.isArray(val) ? val.filter(v => typeof v === "string") : [];
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = "show";
  setTimeout(() => { toast.className = toast.className.replace("show", ""); }, 2000);
}
function showLoading() {
  const el = document.getElementById("loadingOverlay");
  if (el) el.style.display = "flex";
}
function hideLoading() {
  const el = document.getElementById("loadingOverlay");
  if (el) el.style.display = "none";
}
function vibrate(ms=20){ if (navigator.vibrate) try{ navigator.vibrate(ms);}catch(e){} }

function getRecordById(id){
  return allRecords.find(r => r.id === id) || null;
}

// Simple HTML escape for safe text injection
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
}

// Currency helpers (format visually, parse for numeric patch)
function formatUSD(n) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
  } catch (e) {
    var fixed = (isNaN(n) || n === "" || n == null) ? "0.00" : Number(n).toFixed(2);
    return "$" + fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
}
function parseCurrencyInput(str) {
  if (str == null) return null;
  var cleaned = String(str).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "-" || cleaned === "-.") return null;
  var n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// Pick the first existing field name on a record from candidates; else return first candidate
function pickFieldName(obj, candidates) {
  const o = obj || {};
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(o, name)) return name;
  }
  return candidates[0];
}

// If tableId is provided, any array items that look like record IDs are resolved via getCachedRecord(tableId, id).
function normalizeNames(fieldVal, tableId = null) {
  if (Array.isArray(fieldVal)) {
    return fieldVal
      .map(v => {
        if (typeof v === "string") {
          if (tableId && /^rec[A-Za-z0-9]{14}$/.test(v)) {
            return getCachedRecord(tableId, v);
          }
          return v;
        }
        return null;
      })
      .filter(Boolean);
  }
  if (typeof fieldVal === "string") {
    return fieldVal.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

// For link rendering we need id + name
function getLinkedRecords(tableId, fieldVal) {
  const arr = Array.isArray(fieldVal)
    ? fieldVal
    : (typeof fieldVal === "string" ? fieldVal.split(",").map(s => s.trim()).filter(Boolean) : []);

  return arr
    .map(v => {
      if (typeof v === "string" && /^rec[A-Za-z0-9]{14}$/.test(v)) {
        // Try cache first
        let name = getCachedRecord(tableId, v);

        // If cache still holds an ID, try to resolve from preloaded tableRecords
        if (!name || /^rec[A-Za-z0-9]{14}$/.test(name)) {
          const list = tableRecords[tableId] || [];
          const hit = list.find(r => r.id === v);
          if (hit && hit.fields) {
            name =
              hit.fields["Name"] ||
              hit.fields["Vendor Name"] ||
              hit.fields["Vendor"] ||
              hit.fields["Company"] ||
              hit.fields["Company Name"] ||
              hit.fields["Display Name"] ||
              Object.values(hit.fields).find(x => typeof x === "string" && x.trim().length) ||
              v;
            recordCache[`${tableId}_${v}`] = name;
          }
        }
        return { id: v, name: String(name) };
      }
      return { id: null, name: String(v) };
    })
    .filter(x => x.name);
}

// Convenience getters
function getTechNamesFromRecord(rec) {
  const techPlain = rec?.fields?.["Tech name"];
  if (techPlain) return normalizeNames(techPlain, null);
  return normalizeNames(rec?.fields?.["Field Technician"] ?? [], TECH_TABLE);
}
function getBranchNamesFromRecord(rec) {
  return normalizeNames(rec?.fields?.["Vanir Branch"] ?? [], BRANCH_TABLE);
}

/* =========================
   LINKED RECORD PRELOAD
========================= */
async function fetchAllRecords(tableId, keyFields) {
  let records = [];
  let offset = null;

  do {
    let url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}?pageSize=100`;
    if (offset) url += `&offset=${offset}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    if (!res.ok) break;

    const data = await res.json();
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);

  tableRecords[tableId] = records;

  // Build simple display cache: recordId → displayName
  for (const rec of records) {
    let displayName = rec.id;

    // 1) Try preferred keys
    for (const field of keyFields) {
      if (rec.fields && typeof rec.fields[field] === "string" && rec.fields[field].trim().length) {
        displayName = rec.fields[field].trim();
        break;
      }
    }

    // 2) Fallbacks for a human-ish label
    if (displayName === rec.id && rec.fields) {
      const firstString = Object.values(rec.fields).find(v => typeof v === "string" && v.trim().length);
      if (firstString) displayName = firstString.trim();
      else {
        const firstArrayString = Object.values(rec.fields).find(v =>
          Array.isArray(v) && v.length && typeof v[0] === "string" && v[0].trim().length
        );
        if (firstArrayString) displayName = firstArrayString[0].trim();
      }
    }

    recordCache[`${tableId}_${rec.id}`] = displayName;
  }

  return records;
}

function renderPrimaryList(records) {
  const mount = document.getElementById("primary-list") || (() => {
    const d = document.createElement("div");
    d.id = "primary-list";
    d.style.margin = "12px 0";
    document.body.appendChild(d);
    return d;
  })();

  // Replace with your card/row renderer
  mount.innerHTML = records.map(r => {
    const title =
      recordCache[`${TABLE_ID}_${r.id}`] ||
      r.fields?.Name ||
      r.fields?.["Calendar Event Name"] ||
      r.id;
    return `<div class="list-row" data-id="${r.id}" style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:8px;">
      <strong>${escapeHtml(title)}</strong>
    </div>`;
  }).join("");
}

async function preloadLinkedTables() {
  await fetchAllRecords(SUBCONTRACTOR_TABLE, ["Subcontractor Company Name", "Name"]);
  await fetchAllRecords(CUSTOMER_TABLE, ["Client Name", "Name"]);
  await fetchAllRecords(TECH_TABLE, ["Full Name", "Name"]);
  await fetchAllRecords(BRANCH_TABLE, ["Office Name", "Name"]); 
  await fetchAllRecords(VENDOR_TABLE, ["Vendor Name", "Vendor", "Company", "Name", "Display Name"]);
}

function getCachedRecord(tableId, recordId) {
  return recordCache[`${tableId}_${recordId}`] || recordId;
}

/* =========================
   URL PARAM HELPERS (Deep-link filters)
========================= */
function getURLParams(){
  const usp = new URLSearchParams(window.location.search);
  return {
    tech: usp.get("tech") || null,
    branch: usp.get("branch") || null,
    q: usp.get("q") || null
  };
}

function setURLParams({ tech, branch, q }){
  const usp = new URLSearchParams(window.location.search);
  if (tech) usp.set("tech", tech); else usp.delete("tech");
  if (branch) usp.set("branch", branch); else usp.delete("branch");
  if (q) usp.set("q", q); else usp.delete("q");
  const newUrl = `${location.pathname}${usp.toString() ? "?" + usp.toString() : ""}`;
  history.replaceState(null, "", newUrl);
}

/* Applies filters from URL if present; falls back to localStorage */
function applyFiltersFromURLOrStorage(){
  const { tech, branch, q } = getURLParams();

  const branchFilter = document.getElementById("branchFilter");
  const techFilter = document.getElementById("techFilter");
  const searchBar = document.getElementById("searchBar");

  let appliedBranch = null;
  let appliedTech = null;

  // 1) Branch from URL (preferred)
  if (branch && branchFilter) {
    branchFilter.value = branch;
    if (branchFilter.value === branch) {
      activeBranchFilter = branch;
      localStorage.setItem("branchFilter", branch);
    }
  }
  if (!activeBranchFilter) {
    const savedBranch = localStorage.getItem("branchFilter");
    if (savedBranch && branchFilter) {
      branchFilter.value = savedBranch;
      if (branchFilter.value === savedBranch) {
        activeBranchFilter = savedBranch;
      }
    }
  }
  appliedBranch = activeBranchFilter;

  // Rebuild tech dropdown respecting branch
  updateTechDropdown(true);

  // 2) Tech from URL (preferred)
  if (tech && techFilter) {
    const hasOption = Array.from(techFilter.options).some(o => o.value === tech);
    if (!hasOption) {
      const opt = document.createElement("option");
      opt.value = tech;
      opt.textContent = tech;
      techFilter.appendChild(opt);
    }
    techFilter.value = tech;
    if (techFilter.value === tech) {
      activeTechFilter = tech;
      localStorage.setItem("techFilter", tech);
    }
  }
  if (!activeTechFilter) {
    const savedTech = localStorage.getItem("techFilter");
    if (savedTech && techFilter) {
      techFilter.value = savedTech;
      if (techFilter.value === savedTech) {
        activeTechFilter = savedTech;
      }
    }
  }
  appliedTech = activeTechFilter;

  if (q && searchBar) {
    searchBar.value = q;
  }

  setURLParams({
    tech: appliedTech || "",
    branch: appliedBranch || "",
    q: (searchBar?.value || "")
  });

  renderReviews();
}

function updateURLFromCurrentFilters(){
  const searchBar = document.getElementById("searchBar");
  setURLParams({
    tech: activeTechFilter || "",
    branch: activeBranchFilter || "",
    q: (searchBar?.value || "")
  });
}

/* =========================
   FETCH BACKCHARGES
========================= */
async function fetchBackcharges() {
  allRecords = [];
  let offset = null;

  // Use the same VIEW + FILTER as your UI list
  const baseFormula = FILTER_BASE_FORMULA;

  do {
    const url =
      `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}` +
      `?pageSize=100` +
      `&view=${encodeURIComponent(DEFAULT_VIEW_FOR_BG_CHECK)}` +
      `&filterByFormula=${encodeURIComponent(baseFormula)}` +
      (offset ? `&offset=${encodeURIComponent(offset)}` : "");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
    if (!res.ok) break;

    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  // ✅ First time: initialize background checker + banner DOM
  if (!bgIntervalHandle) {
    registerInitialRecords(allRecords);
    ensureBannerDom();
  } else {
    // Keep CURRENT_RECORD_IDS in sync with what's visible now
    CURRENT_RECORD_IDS.clear();
    for (const r of allRecords) CURRENT_RECORD_IDS.add(r.id);
  }

  populateFilterDropdowns();
  renderReviews();
}

/* =========================
   RENDER CARDS
========================= */
function renderReviews() {
  const container = document.getElementById("reviewContainer");
  const searchTerm = (document.getElementById("searchBar")?.value || "").toLowerCase();

  let records = [...allRecords];

  // Apply filters
  if (activeTechFilter) {
    records = records.filter(rec => {
      const techs = getTechNamesFromRecord(rec);
      return techs.includes(activeTechFilter);
    });
  }
  if (activeBranchFilter) {
    records = records.filter(rec => {
      const branches = getBranchNamesFromRecord(rec);
      return branches.includes(activeBranchFilter);
    });
  }

  // Search
  if (searchTerm) {
    records = records.filter(rec => {
      const jobName = (rec.fields["Job Name"] || "").toLowerCase();

      const subcontractor = normalizeNames(rec.fields["Subcontractor to Backcharge"] || [], SUBCONTRACTOR_TABLE)
        .join(", ")
        .toLowerCase();

      const secondarySubField = pickFieldName(rec.fields, [
        "Secondary Subcontractor to backcharge",
        "Secondary Subcontractor to Backcharge",
        "Secondary Subcontractor"
      ]);
      const secondarySubcontractor = normalizeNames(rec.fields[secondarySubField] || [], SUBCONTRACTOR_TABLE)
        .join(", ")
        .toLowerCase();

      const customer = normalizeNames(rec.fields["Customer"] || [], CUSTOMER_TABLE)
        .join(", ")
        .toLowerCase();

      const technician = getTechNamesFromRecord(rec)
        .join(", ")
        .toLowerCase();

      const branch = getBranchNamesFromRecord(rec)
        .join(", ")
        .toLowerCase();

      const idNumber = (rec.fields["ID Number"] ?? "").toString().toLowerCase();

      const vendorNames = getLinkedRecords(VENDOR_TABLE, rec.fields["Vendor Brick and Mortar Location"] || [])
        .map(v => v.name)
        .join(", ")
        .toLowerCase();

      return jobName.includes(searchTerm) ||
             subcontractor.includes(searchTerm) ||
             secondarySubcontractor.includes(searchTerm) ||
             customer.includes(searchTerm) ||
             technician.includes(searchTerm) ||
             branch.includes(searchTerm) ||
             idNumber.includes(searchTerm) ||
             vendorNames.includes(searchTerm);
    });
  }

  container.innerHTML = "";

  records.forEach(record => {
    const fields = record.fields;
    const jobName = fields["Job Name"] || "";
    const reasonFieldName = pickFieldName(fields, ["Reason for Builder Backcharge"]);
    const reason = fields[reasonFieldName] || "";
    const idNumber = fields["ID Number"];

    // 🔧 CHANGED: show amounts separately (sub vs vendor)
    const subBackcharge = fields["Sub Backcharge Amount"];
    const vendorBackcharge = fields["Vendor Amount to Backcharge"];

    let subAmtChip = "";
    if (subBackcharge !== "" && subBackcharge != null) {
      const amt = `$${parseFloat(subBackcharge).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      subAmtChip = `<span class="chip">Subcontractor Amount: ${escapeHtml(amt)}</span>`;
    }

    let vendorAmtChip = "";
    if (vendorBackcharge !== "" && vendorBackcharge != null) {
      const amt = `$${parseFloat(vendorBackcharge).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      vendorAmtChip = `<span class="chip">Vendor Amount: ${escapeHtml(amt)}</span>`;
    }

    // Builder Backcharged Amount chip
    let builderBackchargeChip = "";
    const builderBackcharged = fields["Builder Backcharged Amount"];
    if (builderBackcharged !== "" && builderBackcharged != null) {
      const bAmt = `$${parseFloat(builderBackcharged).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      builderBackchargeChip = `<span class="chip">Builder Backcharge: ${escapeHtml(bAmt)}</span>`;
    }

    const branch = getBranchNamesFromRecord(record).join(", ");
    const techNames = getTechNamesFromRecord(record);
    const technician = techNames.join(", ");
    const customer = normalizeNames(fields["Customer"] || [], CUSTOMER_TABLE).join(", ");
    const subcontractor = normalizeNames(fields["Subcontractor to Backcharge"] || [], SUBCONTRACTOR_TABLE).join(", ");
    const photos = fields["Photos"] || [];
    const photoCount = photos.length;

    // Vendor(s) chip
    const vendors = getLinkedRecords(VENDOR_TABLE, fields["Name"] || []);
    const vendorLinksHtml = vendors.map(v => {
      const safeName = escapeHtml(v.name);
      if (v.id) {
        const url = `https://airtable.com/${BASE_ID}/${VENDOR_TABLE}/${v.id}`;
        return `<a class="chip" href="${url}" target="_blank" rel="noopener">Vendor to backcharge: ${safeName}</a>`;
      }
      return `<span class="chip">Vendor to backcharge: ${safeName}</span>`;
    }).join(" ");

    const idChip = (idNumber !== undefined && idNumber !== null) ? `<span>ID #${idNumber}</span>` : "";
    const branchChip = (branch && branch !== activeBranchFilter) ? `<span class="chip">${escapeHtml(branch)}</span>` : "";

    let techChip = "";
    if (techNames.length === 1) {
      const tech = techNames[0];
      const href = `${location.pathname}?tech=${encodeURIComponent(tech)}${activeBranchFilter ? "&branch="+encodeURIComponent(activeBranchFilter) : ""}`;
      techChip = (tech && tech !== activeTechFilter) ? `<a class="chip" href="${href}" title="Link to ${escapeHtml(tech)}">${escapeHtml(tech)}</a>` : "";
    } else if (technician && technician !== activeTechFilter) {
      techChip = `<span class="chip">${escapeHtml(technician)}</span>`;
    }

    const card = document.createElement("div");
    card.className = "review-card";
    card.setAttribute("data-id", record.id);
    card.setAttribute("tabindex", "0");
    card.innerHTML = `
      <div class="swipe-hint swipe-Approved"></div>
      <div class="swipe-hint swipe-dispute"></div>
      <br>
<p style="
  margin:0 0 8px 0;
  padding:0 52px;
  display:flex;
  justify-content:space-between;
  align-items:center;
">
  ${idChip}
  <span class="job-name" style="flex:1; text-align:right;">${escapeHtml(jobName)}</span>
</p>
      <br>
               <div class="chips">
        ${branchChip}
        ${techChip}
        ${customer ? `<span class="chip">Builder: ${escapeHtml(customer)}</span>` : ""}
        ${subcontractor ? `<span class="chip">Subcontractor to backcharge: ${escapeHtml(subcontractor)}</span>` : ""}
        ${builderBackchargeChip}
        ${subAmtChip}
        ${vendorAmtChip}
        ${vendorLinksHtml || ""}
      </div>
     ${
  reason || photoCount > 0
    ? `
      <div class="reason-photo-row">
        ${reason ? `<div class="kv"><b>Issue:</b> ${escapeHtml(reason)}</div>` : ""}
        ${
          photoCount > 0 
            ? `<div class="photos">
                 <a href="#" class="photo-link" data-id="${record.id}">
                   ${photoCount} image${photoCount > 1 ? "s" : ""}
                 </a>
               </div>` 
            : ""
        }
      </div>
    `
    : ""
}
<div class="decision-buttons">
  <button class="dispute" data-action="Dispute">Dispute</button>
  <button class="approve" data-action="Approve">Approve</button>
</div>
`;

    if (photoCount > 0) {
      const a = card.querySelector(".photo-link");
      a.addEventListener("click", (e) => { 
        e.preventDefault(); 
        openPhotoModal(photos); 
      });
    }

    card.addEventListener("click", () => { 
      lastActiveCardId = record.id; 
      pendingRecordName = jobName || "Unknown Job"; 
      pendingRecordIdNumber = (idNumber !== undefined && idNumber !== null) ? idNumber : null;
    });
    card.addEventListener("focus", () => { 
      lastActiveCardId = record.id; 
      pendingRecordName = jobName || "Unknown Job"; 
      pendingRecordIdNumber = (idNumber !== undefined && idNumber !== null) ? idNumber : null;
    });

    card.querySelectorAll(".decision-buttons button").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        openDecisionSheet(record.id, jobName, action);
      });
    });

    attachSwipeHandlers(card, (dir) => {
      if (dir === "right") { vibrate(15); openDecisionSheet(record.id, jobName, "Approve"); }
      else if (dir === "left") { vibrate(15); openDecisionSheet(record.id, jobName, "Dispute"); }
    });

    container.appendChild(card);
  });
}

/* =========================
   SWIPE HANDLERS
========================= */
function attachSwipeHandlers(el, onCommit){
  let startX = 0, startY = 0, deltaX = 0, active = false;
  let startHeight = 0;
  let horizontalLock = false;

  const resetClasses = () => {
    el.classList.remove("swiping", "swiping-left", "swiping-right", "leaving");
  };

  el.addEventListener("touchstart", (e)=>{
    if (!e.touches || e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    deltaX = 0;
    active = true;
    horizontalLock = false;
    startHeight = el.offsetHeight;

    el.style.transition = "none";
    el.classList.add("swiping");
  }, {passive:true});

  el.addEventListener("touchmove", (e)=>{
    if (!active || !e.touches || e.touches.length !== 1) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    const dx = x - startX;
    const dy = y - startY;

    if (!horizontalLock) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)*1.2) {
        horizontalLock = true;
      } else if (Math.abs(dy) > Math.abs(dx)) {
        return;
      }
    }
    if (!horizontalLock) return;

    deltaX = dx;

    const container = el.parentElement || document.body;
    const w = Math.max(container.clientWidth, 1);
    const progress = Math.min(1, Math.abs(dx) / (w * 0.6));

    const rotate = Math.max(-10, Math.min(10, dx * 0.03));
    const scale  = 1 + (progress * 0.02);
    const opacity = 1 - (progress * 0.1);

    el.style.transform = `translateX(${dx}px) rotate(${rotate}deg) scale(${scale})`;
    el.style.opacity = String(opacity);
    el.classList.toggle("swiping-right", dx > 8);
    el.classList.toggle("swiping-left",  dx < -8);
  }, {passive:true});

  el.addEventListener("touchend", ()=>{
    if (!active) return;

    el.style.transition = "transform .18s ease, opacity .18s ease, box-shadow .18s ease";
    el.classList.remove("swiping-right", "swiping-left");

    const threshold = Math.min((el.parentElement?.clientWidth || window.innerWidth) * 0.28, 160);
    const commitRight = deltaX > threshold;
    const commitLeft  = deltaX < -threshold;

    if (commitRight || commitLeft) {
      const direction = commitRight ? 1 : -1;
      const off = (window.innerWidth || 1000) + el.offsetWidth;

      el.classList.add("leaving");
      el.style.transform = `translateX(${direction * off}px) rotate(${direction*8}deg) scale(1.02)`;
      el.style.opacity = "0.0";

      const collapse = () => {
        el.style.transition = "height .18s ease, margin .18s ease, padding .18s ease";
        el.style.height = `${startHeight}px`;
        void el.offsetHeight;
        el.style.height = "0px";
        el.style.marginTop = "0px";
        el.style.marginBottom = "0px";
        el.style.paddingTop = "0px";
        el.style.paddingBottom = "0px";

        setTimeout(() => {
          onCommit && onCommit(commitRight ? "right" : "left");
          el.style.transform = "";
          el.style.opacity = "";
          el.style.height = "";
          el.style.marginTop = "";
          el.style.marginBottom = "";
          el.style.paddingTop = "";
          el.style.paddingBottom = "";
          resetClasses();
        }, 120);
      };

      setTimeout(collapse, 180);
    } else {
      el.style.transform = "";
      el.style.opacity = "";
      setTimeout(() => resetClasses(), 180);
    }

    active = false;
    deltaX = 0;
  });
}

/* =========================
   PHOTO MODAL
========================= */
function openPhotoModal(photos) {
  const modal = document.getElementById("photoModal");
  const gallery = document.getElementById("photoGallery");
  const closeBtn = modal.querySelector(".close");

  gallery.innerHTML = "";
  photos.forEach(p => {
    const img = document.createElement("img");
    img.src = p.url;
    img.alt = "Field Photo";
    img.classList.add("modal-photo");
    gallery.appendChild(img);
  });

  modal.style.display = "flex";
  closeBtn.onclick = () => modal.style.display = "none";
  modal.onclick = (event) => { if (event.target === modal) modal.style.display = "none"; };
}

/* =========================
   DISPUTE/APPROVE SHEET (editable sub, vendor, amount)
========================= */
function openDecisionSheet(recordId, jobName, decision) {
  pendingRecordId = recordId;
  pendingRecordName = jobName;
  pendingDecision = decision;

  const rec = getRecordById(recordId);
  pendingRecordIdNumber = rec?.fields?.["ID Number"] ?? null;

  const sheet = document.getElementById("decisionSheet");
  const title = document.getElementById("decisionTitle");
  const msg = document.getElementById("decisionMessage");
  const approveBtn = document.getElementById("confirmApproveBtn");
  const disputeBtn = document.getElementById("confirmDisputeBtn");
  const backdrop = document.getElementById("sheetBackdrop");

  ensureDisputeForm(sheet);
  // Show sheet form for BOTH decisions
  disputeFormContainer.style.display = "block";
  sheet.classList.toggle("dispute-mode", decision === "Dispute");

  title.textContent = decision === "Approve" ? "Confirm Approve" : "Confirm Dispute";
  msg.innerHTML = `Are you sure you want to mark <strong>${escapeHtml(jobName || "Unknown Job")}</strong> as "<strong>${escapeHtml(decision)}</strong>"?`;

  approveBtn.style.display = decision === "Approve" ? "block" : "none";
  disputeBtn.style.display = decision === "Dispute" ? "block" : "none";

  // Build selects
  buildSubcontractorOptions(disputeSubSelect);
  buildVendorOptions(disputeVendorSelect);

  // Resolve the vendor link field name and prefill
  const vendorLinkFieldName = getVendorLinkFieldNameForPatch(rec);
  const vendorIds = Array.isArray(rec?.fields?.[vendorLinkFieldName]) ? rec.fields[vendorLinkFieldName] : [];
  if (disputeVendorSelect) {
    disputeVendorSelect.value = "";
    if (vendorIds.length) {
      const vid = vendorIds[0];
      const optExists = [...disputeVendorSelect.options].some(o => o.value === vid);
      if (!optExists && vid) {
        const opt = document.createElement("option");
        opt.value = vid;
        opt.textContent = getCachedRecord(VENDOR_TABLE, vid);
        disputeVendorSelect.appendChild(opt);
      }
      disputeVendorSelect.value = vid;
    }
  }

  // Prefill subcontractor select
  const subIds = Array.isArray(rec?.fields?.["Subcontractor to Backcharge"]) ? rec.fields["Subcontractor to Backcharge"] : [];
  if (disputeSubSelect) {
    disputeSubSelect.value = "";
    if (subIds.length) {
      const sid = subIds[0];
      const optExists = [...disputeSubSelect.options].some(o => o.value === sid);
      if (!optExists && sid) {
        const opt = document.createElement("option");
        opt.value = sid;
        opt.textContent = getCachedRecord(SUBCONTRACTOR_TABLE, sid);
        disputeSubSelect.appendChild(opt);
      }
      disputeSubSelect.value = sid;
    }
  }

  // Prefill reason + amounts
  const reasonFieldName = pickFieldName(rec?.fields || {}, ["Reason for dispute"]);
  const originalReason = rec?.fields?.[reasonFieldName] || "";

  const originalBackcharge = rec?.fields?.["Sub Backcharge Amount"];
  const originalVendorAmt  = rec?.fields?.["Vendor Amount to Backcharge"];

  if (disputeReasonInput) {
    disputeReasonInput.value = originalReason || "";
    disputeReasonInput.placeholder = "(No reason on record)";
  }

  // Sub amount (Backcharge Amount)
  if (originalBackcharge == null || originalBackcharge === "") {
    disputeAmountInput.value = "";
  } else {
    disputeAmountInput.value = formatUSD(originalBackcharge);
  }

  // Vendor amount (Vendor Amount to Backcharge)
  if (originalVendorAmt == null || originalVendorAmt === "") {
    disputeVendorAmountInput.value = "";
  } else {
    disputeVendorAmountInput.value = formatUSD(originalVendorAmt);
  }

  // Prefill conditional backcharge reason fields (if those columns exist)
  const recFields = rec?.fields || {};

  // Sub backcharge reason: prefer an explicit sub backcharge field, fallback to generic if that’s what your base uses
  const subReasonFieldName =
    ["Sub Reason for Backcharge"]
      .find(k => Object.prototype.hasOwnProperty.call(recFields, k)) || null;

  if (subReasonInput) {
    subReasonInput.value = subReasonFieldName ? (recFields[subReasonFieldName] || "") : "";
  }

  // Vendor backcharge reason: handle a few likely schemas, only prefill if present
  const vendorReasonFieldName =
    ["Vendor Backcharge Reason"]
      .find(k => Object.prototype.hasOwnProperty.call(recFields, k)) || null;

  if (vendorReasonInput) {
    vendorReasonInput.value = vendorReasonFieldName ? (recFields[vendorReasonFieldName] || "") : "";
  }

  // Ensure visibility/required state matches current selections and amounts
  try { updateConditionalReasonsUI && updateConditionalReasonsUI(); } catch {}

  // Keep both rows visible/editable in both modes
  const primaryRowEl = disputeFormContainer.querySelector("#bf-primary-sub-row");
  const vendorRowEl  = disputeFormContainer.querySelector("#bf-vendor-row");
  primaryRowEl?.classList.remove("bf-hidden");
  vendorRowEl?.classList.remove("bf-hidden");
  if (disputeAmountInput) disputeAmountInput.disabled = false;
  if (disputeVendorAmountInput) disputeVendorAmountInput.disabled = false;

  approveBtn.classList.toggle("attn", decision === "Approve");   // FIXED
  disputeBtn.classList.toggle("attn", decision === "Dispute");
  approveBtn.textContent = "✔ Approved";
  disputeBtn.textContent = "✖ Dispute";

  sheet.classList.add("open");
  if (backdrop) backdrop.classList.add("show");

  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "decisionTitle");
  sheet.setAttribute("aria-describedby", "decisionMessage");
  sheet.focus();

  document.addEventListener("keydown", onSheetEsc);
}

/* =========================
   BOTTOM SHEET CONFIRM
========================= */
function ensureBackchargeFormStyles() {
  if (document.getElementById("bf-styles")) return;
  const style = document.createElement("style");
  style.id = "bf-styles";
  style.textContent = `
    #disputeFormContainer { width: 100%; padding: 4px 0; }
    #disputeFormContainer .bf-grid {
      display: grid;
      width: 100%;
      grid-template-columns: minmax(0, 1fr) 140px;
      gap: 10px 14px;
      align-items: start;
      box-sizing: border-box;
    }
      #disputeFormContainer .bf-reason label .asterisk { opacity:.9; }

    #disputeFormContainer label {
      font-weight: 600;
      align-self: center;
      font-size: 14px;
      color: white;
    }
    #disputeFormContainer .bf-amount-label {
      text-align: right;
      align-self: center;
      padding-right: 4px;
      white-space: nowrap;
    }
    #disputeFormContainer .bf-display {
      border: 1px solid #e5e7eb;
      background: #f8fafc;
      border-radius: 10px;
      padding: 8px 10px;
    }
    #disputeFormContainer select,
    #disputeFormContainer input[type="text"],
    #disputeFormContainer textarea {
      width: 100%;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 8px 10px;
      font-size: 14px;
      box-sizing: border-box;
    }
    #disputeFormContainer #disputeAmountInput {
      text-align: right;
      padding-right: 10px;
    }
    #disputeFormContainer textarea {
      min-height: 72px;
      resize: vertical;
      line-height: 1.3;
    }
    #disputeFormContainer .bf-row { display: contents; }
    #disputeFormContainer .bf-hidden { display: none !important; }
    #disputeFormContainer .bf-reason {
      grid-template-columns: 80px 1fr;
      gap: 8px;
      align-items: start;
      grid-column: 1 / -1;
    }
    @media (max-width: 640px) {
      #disputeFormContainer .bf-grid {
        grid-template-columns: minmax(0, 1fr) 120px;
      }
      #disputeFormContainer .bf-reason {
        grid-template-columns: 1fr;
      }
      #disputeFormContainer .bf-reason label {
        margin-bottom: 6px;
        align-self: start;
      }
    }
  `;
  document.head.appendChild(style);
}

/* =========================
   DISPUTE/APPROVE FORM (grid-aligned)
========================= */
function ensureDisputeForm(sheet) {
  if (!disputeFormContainer) {
    ensureBackchargeFormStyles();

    disputeFormContainer = document.createElement("div");
    disputeFormContainer.id = "disputeFormContainer";
    disputeFormContainer.style.marginTop = "12px";
    disputeFormContainer.style.display = "none";

    disputeFormContainer.innerHTML = `
  <div class="bf-grid">

    <!-- Row: Subcontractor (editable) -->
    <div id="bf-primary-sub-row" class="bf-row">
      <label for="disputeSubSelect">Subcontractor to Backcharge</label>
      <label class="bf-amount-label" for="disputeAmountInput">Subcontractor Amount</label>

      <select id="disputeSubSelect">
        <option value="">— None —</option>
      </select>
      <input id="disputeAmountInput" type="text" inputmode="decimal" placeholder="$0.00" />
    </div>

    <!-- Row: Vendor (editable) -->
    <div id="bf-vendor-row" class="bf-row">
      <label for="disputeVendorSelect">Vendor to Backcharge</label>
      <label class="bf-amount-label" for="disputeVendorAmountInput">Vendor Amount</label>

      <select id="disputeVendorSelect">
        <option value="">— None —</option>
      </select>
      <input id="disputeVendorAmountInput" type="text" inputmode="decimal" placeholder="$0.00" />
    </div>

        <!-- Row: Sub Reason (conditional full width) -->
    <div id="bf-sub-reason-row" class="bf-reason bf-hidden">
      <label for="subReasonInput">
        Subcontractor Reason <span class="asterisk">*</span>
      </label>
      <textarea id="subReasonInput" placeholder="Required when a Subcontractor amount is entered"></textarea>
    </div>

    <!-- Row: Vendor Reason (conditional full width) -->
    <div id="bf-vendor-reason-row" class="bf-reason bf-hidden">
      <label for="vendorReasonInput">
        Vendor Reason <span class="asterisk">*</span>
      </label>
      <textarea id="vendorReasonInput" placeholder="Required when a Vendor amount is entered"></textarea>
    </div>

    <br>

  

  </div>
`;

    // Wire references
    disputeSubSelect          = disputeFormContainer.querySelector("#disputeSubSelect");
    disputeAmountInput        = disputeFormContainer.querySelector("#disputeAmountInput");

    disputeVendorSelect       = disputeFormContainer.querySelector("#disputeVendorSelect");
    disputeVendorAmountInput  = disputeFormContainer.querySelector("#disputeVendorAmountInput");

    disputeReasonInput        = disputeFormContainer.querySelector("#disputeReasonInput");

    subReasonInput            = disputeFormContainer.querySelector("#subReasonInput");
    vendorReasonInput         = disputeFormContainer.querySelector("#vendorReasonInput");

    const subReasonRow    = disputeFormContainer.querySelector("#bf-sub-reason-row");
    const vendorReasonRow = disputeFormContainer.querySelector("#bf-vendor-reason-row");

    // EXPOSED globally via outer-scope variable
    updateConditionalReasonsUI = () => {
      // regardless of whether a linked record is selected.
      const subAmtVal    = parseCurrencyInput(disputeAmountInput?.value ?? "");
      const vendorAmtVal = parseCurrencyInput(disputeVendorAmountInput?.value ?? "");

      const needSubReason    = subAmtVal != null && subAmtVal > 0;
      const needVendorReason = vendorAmtVal != null && vendorAmtVal > 0;

      // Toggle visibility
      subReasonRow?.classList.toggle("bf-hidden", !needSubReason);
      vendorReasonRow?.classList.toggle("bf-hidden", !needVendorReason);

      // Toggle required attributes for a11y
      if (subReasonInput) {
        subReasonInput.required = needSubReason;
        subReasonInput.setAttribute("aria-required", String(needSubReason));
      }
      if (vendorReasonInput) {
        vendorReasonInput.required = needVendorReason;
        vendorReasonInput.setAttribute("aria-required", String(needVendorReason));
      }
    };

    // Recalculate when user changes selection or amounts
    disputeSubSelect?.addEventListener("change", updateConditionalReasonsUI);
    disputeVendorSelect?.addEventListener("change", updateConditionalReasonsUI);
    disputeAmountInput?.addEventListener("input", updateConditionalReasonsUI);
    disputeVendorAmountInput?.addEventListener("input", updateConditionalReasonsUI);

    // Currency formatting UX
    const hookupMoney = (inp) => {
      inp.addEventListener("blur", () => {
        const n = parseCurrencyInput(inp.value);
        inp.value = (n == null) ? "" : formatUSD(n);
      });
      inp.addEventListener("focus", () => {
        const n = parseCurrencyInput(inp.value);
        inp.value = (n == null) ? "" : String(n);
        try {
          const len = inp.value.length;
          inp.setSelectionRange(len, len);
        } catch(e){}
      });
    };
    hookupMoney(disputeAmountInput);
    hookupMoney(disputeVendorAmountInput);

    sheet.appendChild(disputeFormContainer);
  }
}

// Build subcontractor options from preloaded table
function buildSubcontractorOptions(selectEl) {
  if (!selectEl) return;

  const existing = new Set([...selectEl.options].map(o => o.value));
  const recs = tableRecords[SUBCONTRACTOR_TABLE] || [];

  const normalizeName = (str) =>
    (str || "")
      .replace(/[(){}]/g, "")
      .trim();

  const subs = recs.map(r => {
    const rawName = r.fields["Subcontractor Company Name"] || r.fields["Name"] || r.id;
    return {
      id: r.id,
      name: rawName,
      sortKey: normalizeName(rawName).toLowerCase()
    };
  });

  subs.sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: "base" }));

  for (const { id, name } of subs) {
    if (!existing.has(id)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      selectEl.appendChild(opt);
    }
  }
}

// Build vendor options from preloaded table
function buildVendorOptions(selectEl) {
  if (!selectEl) return;

  const existing = new Set([...selectEl.options].map(o => o.value));
  const recs = tableRecords[VENDOR_TABLE] || [];

  const normalizeName = (str) => (str || "").replace(/[(){}]/g, "").trim();

  const vendors = recs.map(r => {
    const rawName =
      r.fields["Vendor Name"] ||
      r.fields["Vendor"] ||
      r.fields["Company"] ||
      r.fields["Name"] ||
      r.fields["Display Name"] ||
      r.id;
    return {
      id: r.id,
      name: rawName,
      sortKey: normalizeName(rawName).toLowerCase()
    };
  });

  vendors.sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { sensitivity: "base" }));

  for (const { id, name } of vendors) {
    if (!existing.has(id)) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      selectEl.appendChild(opt);
    }
  }
}

// Try to select by recordId or by display name (case-insensitive)
function selectOptionByIdOrName(selectEl, val) {
  if (!selectEl) return;
  selectEl.value = "";
  if (!val) return;

  if (typeof val === "string" && /^rec[A-Za-z0-9]{14}$/.test(val)) {
    const found = [...selectEl.options].some(o => o.value === val);
    if (found) { selectEl.value = val; return; }
  }

  const name = (typeof val === "string") ? val : String(val);
  const lower = name.toLowerCase().trim();
  for (const o of selectEl.options) {
    if (o.textContent.toLowerCase().trim() === lower) {
      selectEl.value = o.value;
      return;
    }
  }
}

function closeDecisionSheet(){
  const sheet = document.getElementById("decisionSheet");
  const backdrop = document.getElementById("sheetBackdrop");
  const approveBtn = document.getElementById("confirmApproveBtn");
  const disputeBtn = document.getElementById("confirmDisputeBtn");

  sheet.classList.remove("open");
  sheet.classList.remove("dispute-mode");
  if (backdrop) backdrop.classList.remove("show");

  approveBtn.classList.remove("attn");
  disputeBtn.classList.remove("attn");

  if (disputeFormContainer) {
    disputeFormContainer.style.display = "none";
    if (disputeReasonInput) disputeReasonInput.value = "";
    if (disputeAmountInput) disputeAmountInput.value = "";
    if (disputeVendorAmountInput) disputeVendorAmountInput.value = "";
    if (disputeSubSelect) disputeSubSelect.value = "";
    if (disputeVendorSelect) disputeVendorSelect.value = "";
    // Re-enable inputs
    if (disputeAmountInput) disputeAmountInput.disabled = false;
    if (disputeVendorAmountInput) disputeVendorAmountInput.disabled = false;
  }

  pendingDecision = null;
  pendingRecordId = null;
  pendingRecordName = null;
  pendingRecordIdNumber = null;

  document.removeEventListener("keydown", onSheetEsc);
}

function onSheetEsc(e){ if (e.key === "Escape") closeDecisionSheet(); }

/* =========================
   PATCH TO AIRTABLE
========================= */

// 🔧 CHANGED: helper to pick the vendor **linked-record** field safely
function getVendorLinkFieldNameForPatch(rec) {
  const f = rec?.fields || {};
  const candidates = ["Vendor Brick and Mortar Location"];
  // Prefer whichever currently contains linked-record IDs
  for (const k of candidates) {
    const v = f[k];
    if (looksLikeLinkedIds(v)) return k;
  }
  // Fallback to the conventional linked field
  return "Vendor Brick and Mortar Location";
}

async function confirmDecision(decision) {
  if (!pendingRecordId || !decision) {
    console.warn("⚠️ confirmDecision called without recordId or decision", { pendingRecordId, decision });
    return;
  }

  console.log("➡️ confirmDecision start", { recordId: pendingRecordId, decision });

  // Always set the decision
  const fieldsToPatch = { "Approved or Dispute": decision };

  // Allow editing sub/vendor/amount for BOTH Approve and Dispute
  const rec = getRecordById(pendingRecordId);

  // Gather selections
  const selectedSubId    = disputeSubSelect?.value || "";
  const selectedVendorId = disputeVendorSelect?.value || "";

  // Gather amounts (each maps to its own field)
  const subAmtRaw    = disputeAmountInput?.value?.trim() || "";
  const vendorAmtRaw = disputeVendorAmountInput?.value?.trim() || "";

  const subAmtParsed    = subAmtRaw ? parseCurrencyInput(subAmtRaw)    : null;
  const vendorAmtParsed = vendorAmtRaw ? parseCurrencyInput(vendorAmtRaw) : null;

  // 🔧 CHANGED: Validate each independently (if provided)
  if (subAmtParsed != null && (isNaN(subAmtParsed) || subAmtParsed < 0)) {
    alert("Please enter a valid positive Subcontractor Amount.");
    disputeAmountInput?.focus();
    return;
  }
  if (vendorAmtParsed != null && (isNaN(vendorAmtParsed) || vendorAmtParsed < 0)) {
    alert("Please enter a valid positive Vendor Amount.");
    disputeVendorAmountInput?.focus();
    return;
  }

  // Patch link fields
  fieldsToPatch["Subcontractor to Backcharge"] = selectedSubId ? [selectedSubId] : [];

  // 🔧 CHANGED: patch the correct vendor **linked field** only
  const vendorLinkFieldName = getVendorLinkFieldNameForPatch(rec);
  fieldsToPatch[vendorLinkFieldName] = selectedVendorId ? [selectedVendorId] : [];

  // 🔧 CHANGED: patch **both** amount fields independently (no winner)
  fieldsToPatch["Sub Backcharge Amount"] = subAmtParsed == null ? null : subAmtParsed;

  // Always send it; Airtable omits empty fields from reads, but you can still write them.
  fieldsToPatch["Vendor Amount to Backcharge"] =
    vendorAmtParsed == null ? null : vendorAmtParsed;

  // === Conditional reason requirements ===
  // 🔧 CHANGED: reasons are required whenever amount > 0 (regardless of selection)
  const needSubReason    = (subAmtParsed != null && subAmtParsed > 0);
  const needVendorReason = (vendorAmtParsed != null && vendorAmtParsed > 0);

  // Block if required reasons are missing
  if (needSubReason && !(subReasonInput?.value || "").trim()) {
    alert("Please provide a Subcontractor Reason when an amount is entered.");
    subReasonInput?.focus();
    return;
  }
  if (needVendorReason && !(vendorReasonInput?.value || "").trim()) {
    alert("Please provide a Vendor Reason when an amount is entered.");
    vendorReasonInput?.focus();
    return;
  }

  // === Prepare reason fields to patch ===
  const recFields = rec?.fields || {};

  // Sub reason field (prioritize an explicit sub-backcharge reason column)
  const subReasonFieldName =
    ["Sub Reason for Backcharge"]
      .find(k => Object.prototype.hasOwnProperty.call(recFields, k)) || null;

  if (needSubReason && subReasonFieldName) {
    fieldsToPatch[subReasonFieldName] = (subReasonInput?.value || "").trim();
  }

  // Vendor reason field (only patch if column exists to avoid 422)
  const vendorReasonFieldName =
    ["Vendor Backcharge reason"]
      .find(k => Object.prototype.hasOwnProperty.call(recFields, k)) || null;

  if (needVendorReason && vendorReasonFieldName) {
    fieldsToPatch[vendorReasonFieldName] = (vendorReasonInput?.value || "").trim();
  }

  // Keep existing behavior: when Dispute, also write the generic dispute reason if your base uses that.
  if (decision === "Dispute") {
    const disputeReasonField = ["Reason for Builder Backcharge"]
      .find(k => Object.prototype.hasOwnProperty.call(recFields, k));
    if (disputeReasonField && disputeReasonInput) {
      fieldsToPatch[disputeReasonField] = (disputeReasonInput.value || "").trim() || null;
    }
  }

  console.log("📤 PATCH payload prepared:", fieldsToPatch);

  showLoading();
  try {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}/${pendingRecordId}`;
    console.log("🌐 PATCH request to:", url);

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: fieldsToPatch })
    });

    if (!res.ok) {
      let error;
      try { error = await res.json(); } catch { error = { error: { message: `HTTP ${res.status}` } }; }
      console.error("❌ Failed to update record:", error);
      alert(`Failed to update record: ${error.error?.message || JSON.stringify(error)}`);
      return;
    }

    const updated = await res.json();
    console.log("✅ Record successfully updated:", updated);

    vibrate(30);

    const idFrag = (pendingRecordIdNumber !== null && pendingRecordIdNumber !== undefined) ? `ID #${pendingRecordIdNumber} – ` : "";
    showToast(`${idFrag}${pendingRecordName || "Record"} marked as ${decision}`);

    console.log("🔄 Refreshing backcharges...");
    await fetchBackcharges();
  } catch (err) {
    console.error("🔥 Exception in confirmDecision:", err);
  } finally {
    hideLoading();
    closeDecisionSheet();
    console.log("🏁 confirmDecision finished");
  }
}

/* =========================
   FILTER DROPDOWNS
========================= */
function populateFilterDropdowns() {
  const branchSet = new Set();

  for (const rec of allRecords) {
    (rec.fields["Vanir Branch"] || []).forEach(id => {
      branchSet.add(getCachedRecord(BRANCH_TABLE, id));
    });
  }

  const branchFilter = document.getElementById("branchFilter");
  branchFilter.innerHTML = `<option value="">-- All Branches --</option>`;
  [...branchSet].sort().forEach(name => {
    branchFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  });

  updateTechDropdown(true);
}

function updateTechDropdown(skipClear = false) {
  const branchFilter = document.getElementById("branchFilter");
  const selectedBranch = branchFilter?.value || "";

  const techSet = new Set();

  for (const rec of allRecords) {
    const recordBranches = getBranchNamesFromRecord(rec);
    const recordTechs = getTechNamesFromRecord(rec);
    if (!selectedBranch || recordBranches.includes(selectedBranch)) {
      recordTechs.forEach(t => techSet.add(t));
    }
  }

  const techFilter = document.getElementById("techFilter");
  techFilter.innerHTML = `<option value="">-- All Technicians --</option>`;
  [...techSet].sort().forEach(name => {
    techFilter.innerHTML = techFilter.innerHTML + `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
  });

  if (activeTechFilter) {
    const optionExists = Array.from(techFilter.options).some(opt => opt.value === activeTechFilter);
    if (!optionExists) {
      const opt = document.createElement("option");
      opt.value = activeTechFilter;
      opt.textContent = activeTechFilter;
      techFilter.appendChild(opt);
    }
    techFilter.value = activeTechFilter;
  }

  if (!skipClear && !techSet.has(activeTechFilter)) {
    activeTechFilter = null;
    localStorage.removeItem("techFilter");
  }

  if (skipClear && !hasRestoredFilters) {
    hasRestoredFilters = true;
    restoreFilters();
  }
}

function restoreFilters() {
  applyFiltersFromURLOrStorage();
}

/* =========================
   EVENT WIRING
========================= */
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("cancelDecisionBtn").onclick = closeDecisionSheet;
  document.getElementById("confirmApproveBtn").onclick = ()=> confirmDecision("Approved");
  document.getElementById("confirmDisputeBtn").onclick = ()=> confirmDecision("Dispute");

  const techFilter = document.getElementById("techFilter");
  const branchFilter = document.getElementById("branchFilter");
  const searchBar = document.getElementById("searchBar");

  if (techFilter) {
    techFilter.addEventListener("change", e => {
      if (e.target.value) {
        activeTechFilter = e.target.value;
        localStorage.setItem("techFilter", e.target.value);
      } else {
        activeTechFilter = null;
        localStorage.removeItem("techFilter");
      }
      updateURLFromCurrentFilters();
      renderReviews();
    });
  }

  if (branchFilter) {
    branchFilter.addEventListener("change", e => {
      if (e.target.value) {
        activeBranchFilter = e.target.value;
        localStorage.setItem("branchFilter", e.target.value);
      } else {
        activeBranchFilter = null;
        localStorage.removeItem("branchFilter");
        const c = document.getElementById("branchFilterContainer");
        if (c) c.style.display = "block";
      }
      updateTechDropdown(); 
      updateURLFromCurrentFilters();
      renderReviews();
    });
  }

  if (searchBar) {
    searchBar.addEventListener("input", () => {
      updateURLFromCurrentFilters();
      renderReviews();
    });
  }
  const backdrop = document.getElementById("sheetBackdrop");
  if (backdrop) {
    backdrop.addEventListener("click", closeDecisionSheet);
  }
});

/* =========================
   INIT
========================= */
(async () => {
  showLoading();
  try{
    await preloadLinkedTables();
    await fetchBackcharges();
    applyFiltersFromURLOrStorage();
  } finally{
    hideLoading();
  }
})();

/** Poll interval (ms) */
const BACKGROUND_CHECK_INTERVAL_MS = 15 * 60 * 1000; // 900000 ms = 15 minutes

/** LocalStorage keys */
const LS_AUTOLOAD = "vanir_autoload_new_records";
const LS_LAST_CHECK_ISO = "vanir_last_check_iso";

/** Runtime state */
const CURRENT_RECORD_IDS = new Set();
let INITIAL_LOAD_ISO = new Date().toISOString();
let bgIntervalHandle = null;
let bgInFlight = false;

function registerInitialRecords(records) {
  try {
    CURRENT_RECORD_IDS.clear();
    for (const r of (records || [])) {
      if (r && r.id) CURRENT_RECORD_IDS.add(r.id);
    }
    INITIAL_LOAD_ISO = new Date().toISOString();
    localStorage.setItem(LS_LAST_CHECK_ISO, INITIAL_LOAD_ISO);

    // Default autoload ON if not yet set
    if (localStorage.getItem(LS_AUTOLOAD) == null) {
      localStorage.setItem(LS_AUTOLOAD, "1");
    }

    // Start the background checker once we know what’s in the UI
    startBackgroundNewRecordsCheck();
  } catch (e) {
    console.error("registerInitialRecords error:", e);
  }
}

function startBackgroundNewRecordsCheck() {
  if (bgIntervalHandle) return;

  const tick = async () => {
    stopConsoleCountdown(); // pause countdown while we work

    if (bgInFlight) return;
    bgInFlight = true;
    try {
      const sinceIso = localStorage.getItem(LS_LAST_CHECK_ISO) || INITIAL_LOAD_ISO;
      console.log("🔎 Background fetch starting… (since:", sinceIso, ")");
      const updates = await fetchUpdatedRecordsSince(sinceIso);

      // figure out what to add/remove based on *current* field values
      const toAdd = updates.filter(r => recordMatchesScope(r) && !CURRENT_RECORD_IDS.has(r.id));
      const toRemove = updates.filter(r => !recordMatchesScope(r) && CURRENT_RECORD_IDS.has(r.id));

      // ADD: only records that still match our scope (Approved/Dispute empty)
      if (toAdd.length > 0) {
        const shouldAutoload = FORCE_AUTOLOAD || (localStorage.getItem(LS_AUTOLOAD) === "1");
        if (shouldAutoload) {
          renderNewRecords(toAdd);
          toAdd.forEach(r => CURRENT_RECORD_IDS.add(r.id));
          console.log(`✅ Auto-loaded ${toAdd.length} new record${toAdd.length>1?'s':''}`);
        } else {
          showNewRecordsBanner(toAdd);
        }
      }

      // PRUNE: anything that no longer matches scope (now approved/disputed)
      if (toRemove.length > 0) {
        const ids = new Set(toRemove.map(r => r.id));
        allRecords = allRecords.filter(r => !ids.has(r.id));
        ids.forEach(id => CURRENT_RECORD_IDS.delete(id));
        populateFilterDropdowns();
        renderReviews();
        console.log(`🧹 Removed ${toRemove.length} record${toRemove.length>1?'s':''} that left scope`);
      }

      // 30s overlap to avoid missing near-boundary updates
      const nextIso = new Date(Date.now() - 30 * 1000).toISOString();
      localStorage.setItem(LS_LAST_CHECK_ISO, nextIso);
    } catch (e) {
      console.error("Background check failed:", e);
    } finally {
      bgInFlight = false;
      startConsoleCountdown(BACKGROUND_CHECK_INTERVAL_MS); // restart countdown to next tick
    }
  };

  bgIntervalHandle = setInterval(tick, BACKGROUND_CHECK_INTERVAL_MS);
  setTimeout(tick, 1500);           // quick first run
  startConsoleCountdown(1500);      // and a short countdown to it

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (bgIntervalHandle) { clearInterval(bgIntervalHandle); bgIntervalHandle = null; }
      stopConsoleCountdown();
    } else {
      if (!bgIntervalHandle) bgIntervalHandle = setInterval(tick, BACKGROUND_CHECK_INTERVAL_MS);
      setTimeout(tick, 1500);
      startConsoleCountdown(1500);
    }
  });

  // (The duplicate setInterval/listener block has been deduped)
}

function showBgToast(text, ms = 3000) {
  const el = document.getElementById("new-records-toast");
  el.textContent = text;
  el.style.display = "block";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = "none"; }, ms);
}

function ensureBannerDom() {
  if (document.getElementById("new-records-banner")) return;
  const css = document.createElement("style");
  css.textContent = `
    #new-records-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;display:none;background:#0f172a;color:#f8fafc;border:1px solid #1e293b;border-radius:14px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
    #new-records-banner .nb-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    #new-records-banner .nb-msg{font-weight:600;line-height:1.2;flex:1 1 auto;min-width:180px}
    #new-records-banner .nb-actions{display:flex;gap:8px;flex-wrap:wrap}
    #new-records-banner button{appearance:none;border:1px solid transparent;border-radius:10px;padding:8px 12px;font-weight:600;cursor:pointer}
    #new-records-banner .nb-load{background:#22c55e;color:#052e10;border-color:#16a34a}
    #new-records-banner .nb-dismiss{background:#0b1220;color:#cbd5e1;border-color:#334155}
    #new-records-banner label.nb-autoload{display:inline-flex;align-items:center;gap:8px;font-size:.9rem;opacity:.9}
    #new-records-toast{position:fixed;right:12px;bottom:12px;z-index:9999;display:none;background:#111827;color:#e5e7eb;border:1px solid #1f2937;border-radius:12px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
  `;
  document.head.appendChild(css);

  const banner = document.createElement("div");
  banner.id = "new-records-banner";
  banner.innerHTML = `
    <div class="nb-row">
      <div class="nb-msg"></div>
      <div class="nb-actions">
        <button type="button" class="nb-load">Load</button>
        <button type="button" class="nb-dismiss">Dismiss</button>
        <label class="nb-autoload"><input type="checkbox" class="nb-autoload-input"> Always auto-load</label>
      </div>
    </div>`;
  document.body.appendChild(banner);

  const toast = document.createElement("div");
  toast.id = "new-records-toast";
  document.body.appendChild(toast);
}

async function fetchUpdatedRecordsSince(sinceIso) {
  const urlBase = `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(TABLE_ID)}`;
  const headers = { "Authorization": `Bearer ${AIRTABLE_API_KEY}` };

  const filter = `OR(
    IS_AFTER(CREATED_TIME(), DATETIME_PARSE("${sinceIso}")),
    IS_AFTER(LAST_MODIFIED_TIME(), DATETIME_PARSE("${sinceIso}"))
  )`;

  const params = new URLSearchParams();
  params.set("pageSize", "100");
  params.set("filterByFormula", filter);

  let all = [];
  let offset = null;

  do {
    const qp = new URLSearchParams(params);
    if (offset) qp.set("offset", offset);

    const res = await fetch(`${urlBase}?${qp.toString()}`, { headers });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      throw new Error(`Airtable list failed (${res.status}): ${msg}`);
    }
    const json = await res.json();
    all = all.concat(json.records || []);
    offset = json.offset;
  } while (offset);

  return all;
}

/**
 * Minimal banner UI: asks user to load unseen records.
 */
function showNewRecordsBanner(unseenRecords) {
  ensureBannerDom();

  const banner = document.getElementById("new-records-banner");
  const msg = banner.querySelector(".nb-msg");
  const btnLoad = banner.querySelector(".nb-load");
  const btnDismiss = banner.querySelector(".nb-dismiss");
  const autoloadChk = banner.querySelector(".nb-autoload-input");

  msg.textContent = `${unseenRecords.length} record${unseenRecords.length>1?"s":""} not in view. Load now?`;
  autoloadChk.checked = (localStorage.getItem(LS_AUTOLOAD) === "1");
  banner.style.display = "block";

  btnLoad.replaceWith(btnLoad.cloneNode(true));
  btnDismiss.replaceWith(btnDismiss.cloneNode(true));
  const newLoad = banner.querySelector(".nb-load");
  const newDismiss = banner.querySelector(".nb-dismiss");

  newLoad.addEventListener("click", () => {
    renderNewRecords(unseenRecords);
    unseenRecords.forEach(r => CURRENT_RECORD_IDS.add(r.id));
    banner.style.display = "none";
  });

  newDismiss.addEventListener("click", () => {
    banner.style.display = "none";
  });

  autoloadChk.addEventListener("change", (e) => {
    localStorage.setItem(LS_AUTOLOAD, e.target.checked ? "1" : "0");
  }, { once: true });
}

function renderNewRecords(records) {
  try {
    if (!Array.isArray(records) || records.length === 0) return;

    // Merge unique-by-id
    const seen = new Set(allRecords.map(r => r.id));
    const toAdd = records.filter(r => r && r.id && !seen.has(r.id));
    if (toAdd.length === 0) return;

    allRecords = allRecords.concat(toAdd);

    // Keep filters/dropdowns fresh and re-render cards
    populateFilterDropdowns();
    renderReviews();
  } catch (e) {
    console.error("renderNewRecords error:", e);
  }
}
