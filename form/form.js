/* =============================
   form.js – Backcharge form (Dropbox photo upload → Airtable "Photos")
   - ES5-safe (no optional chaining / nullish coalescing / arrows)
   - Branch-name ↔ linked-ID filtering preserved
   - Uploads selected files to Dropbox and patches Airtable "Photos" with direct links
   - UPDATED: "Tech name" is now a plain text field, not a linked-record array
   - UPDATED: Backcharge Amount is a currency input (pretty UI; numeric sent to Airtable)
   ============================= */

import { fetchDropboxToken, uploadFileToDropbox } from "../dropbox.js";


// ---- Airtable config ----
const AIRTABLE_API_KEY = "pat6QyOfQCQ9InhK4.4b944a38ad4c503a6edd9361b2a6c1e7f02f216ff05605f7690d3adb12c94a3c";
const BASE_ID = "appQDdkj6ydqUaUkE";
const TABLE_ID = "tbl1LwBCXM0DYQSJH"; // Backcharges table

// Linked tables
const CUSTOMER_TABLE = "tblQ7yvLoLKZlZ9yU";
const TECH_TABLE     = "tblj6Fp0rvN7QyjRv";
const BRANCH_TABLE   = "tblD2gLfkTtJYIhmK";

// Cache data for filtering
var branchRecords = {};   // { branchRecordId: "Office Name" }
var customerRecords = [];
var techRecords = [];

// Excluded branches
var excludedBranches = ["Test Branch", "Airtable Hail Mary Test", "AT HM Test"];

/* ---------- Small DOM helpers ---------- */
function q(sel){ return document.querySelector(sel); }
function val(sel){ var el = q(sel); return el ? el.value : ""; }

/* ---------- Currency helpers (format visually, store numeric) ---------- */
function formatUSD(n) {
  try {
    // Use Intl for display only
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
  } catch (e) {
    // Fallback minimal formatting
    var fixed = (isNaN(n) || n === "" || n == null) ? "0.00" : Number(n).toFixed(2);
    return "$" + fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
}

function parseCurrencyInput(str) {
  // Keep digits, decimal, and minus; then parse
  if (str == null) return null;
  var cleaned = String(str).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "." || cleaned === "-" || cleaned === "-.") return null;
  var n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function attachCurrencyBehaviors(inputEl) {
  if (!inputEl) return;

  // Show formatted on blur
  inputEl.addEventListener("blur", function(){
    var n = parseCurrencyInput(inputEl.value);
    inputEl.value = (n == null) ? "" : formatUSD(n);
  });

  // Show raw number while editing
  inputEl.addEventListener("focus", function(){
    var n = parseCurrencyInput(inputEl.value);
    inputEl.value = (n == null) ? "" : String(n);
    // Move caret to end (best-effort)
    try {
      var len = inputEl.value.length;
      inputEl.setSelectionRange(len, len);
    } catch (_e) {}
  });

  // Keep it friendly during typing (optional: just let user type; strict filtering can be annoying)
  inputEl.addEventListener("input", function(){
    // No-op; we parse on submit. You can add live validation UI here if desired.
  });

  // Initial pretty format if there is a prefilled value
  var initial = parseCurrencyInput(inputEl.value);
  if (initial != null) inputEl.value = formatUSD(initial);
}

/* ---------- Utils ---------- */
function atHeaders() {
  return {
    Authorization: "Bearer " + AIRTABLE_API_KEY,
    "Content-Type": "application/json",
  };
}

async function fetchAll(tableId) {
  var allRecords = [];
  var offset = null;
  try {
    do {
      var url = "https://api.airtable.com/v0/" + BASE_ID + "/" + tableId + "?pageSize=100";
      if (offset) url += "&offset=" + encodeURIComponent(offset);
      var res = await fetch(url, { headers: atHeaders() });
      var data = await res.json();
      if (!res.ok) {
        console.error("fetchAll error:", tableId, data);
        break;
      }
      if (data && Array.isArray(data.records)) allRecords = allRecords.concat(data.records);
      offset = data ? data.offset : null;
    } while (offset);
  } catch (err) {
    console.error("fetchAll exception:", tableId, err);
  }
  return allRecords;
}

// Escape internal double-quotes for Airtable string literal
function escapeAirtableString(value) {
  var v = (value == null ? "" : value);
  return String(v).replace(/"/g, '\\"');
}

// Build a case-insensitive, space-insensitive formula:
//   LOWER(TRIM({Field})) = LOWER("value")
function makeFilterFormulaInsensitive(fieldName, rawValue) {
  var trimmed = String(rawValue == null ? "" : rawValue).trim();
  var safe = escapeAirtableString(trimmed);
  return "LOWER(TRIM({" + fieldName + "})) = LOWER(\"" + safe + "\")";
}

// Helper: find recordId by text match (case/space-insensitive)
async function findRecordId(tableId, fieldName, value) {
  if (!value) return null;
  var formula = makeFilterFormulaInsensitive(fieldName, value);
  var url = "https://api.airtable.com/v0/" + BASE_ID + "/" + tableId + "?maxRecords=1&filterByFormula=" + encodeURIComponent(formula);

  // For debugging visibility:
  console.debug("[findRecordId] GET", { tableId: tableId, fieldName: fieldName, value: value, url: url, formulaRaw: formula });

  var res = await fetch(url, { headers: atHeaders() });
  var data = {};
  try { data = await res.json(); } catch (_) {}

  if (!res.ok) {
    console.error("findRecordId error:", { status: res.status, url: url, data: data });
    return null;
  }
  if (data && data.records && data.records.length && data.records[0] && data.records[0].id) {
    return data.records[0].id;
  }
  return null;
}

/* ---------- Branch-aware filtering helpers ---------- */

// Normalize a branch cell (could be a linked-record array of IDs or a name string)
// -> returns an array of **branch names**
function normalizeBranchCellToNames(cell) {
  if (!cell) return [];
  if (Array.isArray(cell)) {
    return cell.map(function(v){ return branchRecords[v] || String(v); });
  }
  return [branchRecords[cell] || String(cell)];
}

// Does a record belong to the selected branch name, given the record's branch field?
function recordMatchesBranchName(rec, branchFieldName, selectedBranchName) {
  if (!selectedBranchName) return true; // no filter
  var cell = (rec && rec.fields) ? rec.fields[branchFieldName] : undefined;
  if (!cell) return false;

  var names = normalizeBranchCellToNames(cell)
    .map(function(s){ return String(s).trim().toLowerCase(); })
    .filter(function(x){ return !!x; });

  var target = String(selectedBranchName).trim().toLowerCase();
  return names.indexOf(target) !== -1;
}

/* ---------- UI population ---------- */

// Populate a <select> dropdown
function populateSelectFromArray(records, fieldName, selectId, branchFilterName, branchFieldName) {
  if (typeof branchFieldName === "undefined") branchFieldName = "Division";
  var select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = "<option value=\"\">-- Select --</option>";

  var options = records
    .filter(function(rec){ return rec.fields && rec.fields[fieldName]; })
    .filter(function(rec){ return recordMatchesBranchName(rec, branchFieldName, branchFilterName || null); })
    .map(function(rec){ return rec.fields[fieldName]; });

  // Deduplicate + sort
  var seen = {};
  options = options.filter(function(v){
    var k = String(v);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  }).sort(function(a, b){ return String(a).localeCompare(String(b)); });

  options.forEach(function(val){
    var option = document.createElement("option");
    option.value = val;
    option.textContent = val;
    select.appendChild(option);
  });

  if (options.length === 0 && branchFilterName) {
    console.warn("[populateSelectFromArray] No options after filtering by branch \"" + branchFilterName + "\" on field \"" + branchFieldName + "\". Check data/linking.");
  }
}

// Populate branch dropdown
function populateBranchDropdown(branches) {
  var branchSelect = document.getElementById("branch");
  if (!branchSelect) return;
  branchSelect.innerHTML = "<option value=\"\">-- Select Branch --</option>";

  var options = branches
    .filter(function(b){ return b.fields && b.fields["Office Name"] && excludedBranches.indexOf(b.fields["Office Name"]) === -1; })
    .map(function(b){ return b.fields["Office Name"]; })
    .sort(function(a, b){ return String(a).localeCompare(String(b)); });

  options.forEach(function(name){
    var option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    branchSelect.appendChild(option);
  });
}

// Init dropdowns
async function initDropdowns() {
  var branches = await fetchAll(BRANCH_TABLE);
  customerRecords = await fetchAll(CUSTOMER_TABLE);
  techRecords     = await fetchAll(TECH_TABLE);

  // Build branch ID -> name map
  branches.forEach(function(b){
    if (b.fields && b.fields["Office Name"] && excludedBranches.indexOf(b.fields["Office Name"]) === -1) {
      branchRecords[b.id] = b.fields["Office Name"];
    }
  });

  populateBranchDropdown(branches);

  // Populate full lists initially (no filter)
  populateSelectFromArray(customerRecords, "Client Name", "customer", null, "Division");
  populateSelectFromArray(techRecords,     "Full Name",   "technician", null, "Vanir Office");
}

// Handle branch selection → filter others
var branchEl = document.getElementById("branch");
if (branchEl) {
  branchEl.addEventListener("change", function(e){
    var branchName = e.target.value; // branch NAME
    if (branchName) {
      populateSelectFromArray(customerRecords, "Client Name", "customer", branchName, "Division");
      populateSelectFromArray(techRecords,     "Full Name",   "technician", branchName, "Vanir Office");
    } else {
      populateSelectFromArray(customerRecords, "Client Name", "customer", null, "Division");
      populateSelectFromArray(techRecords,     "Full Name",   "technician", null, "Vanir Office");
    }
  });
}

/* ---------- Dropbox helpers ---------- */

// Turn FileList -> Array<File>
function filesFromInput(inputId){
  var input = document.getElementById(inputId);
  if (!input || !input.files || !input.files.length) return [];
  return Array.prototype.slice.call(input.files);
}

async function uploadPhotosAndGetAttachments() {
  // Get file objects from <input type="file" id="photos" multiple>
  var files = filesFromInput("photos");
  if (!files.length) return []; // no photos selected

  // Get Dropbox token & creds from Airtable (via dropb.js)
  var creds = await fetchDropboxToken();
  if (!creds || !creds.token) {
    alert("Couldn't fetch Dropbox credentials. Please try again or contact admin.");
    return [];
  }

  // Upload all files (in parallel) → direct URLs
  var uploadPromises = files.map(function(file){
    return uploadFileToDropbox(file, creds.token, creds); // returns direct link or null
  });

  var urls = await Promise.all(uploadPromises);
  // Build Airtable attachment array (filter out failures)
  var attachments = [];
  for (var i = 0; i < urls.length; i++) {
    if (urls[i]) {
      attachments.push({
        url: urls[i],
        filename: files[i].name
      });
    } else {
      console.warn("Upload failed for file:", files[i] && files[i].name);
    }
  }
  return attachments;
}

/* ---------- Submit handler ---------- */
var formEl = document.getElementById("backchargeForm");
if (formEl) {
  // Attach currency behaviors when the form exists
  attachCurrencyBehaviors(document.getElementById("amount"));

  formEl.addEventListener("submit", async function(e){
    e.preventDefault();

    var customer   = val("#customer");
    var technician = val("#technician");
    var branch     = val("#branch");
    var jobName    = val("#jobName");
    var reason     = val("#reason");

    // Early block if any required select is empty
    var missingRequired = [];
    if (!customer)   missingRequired.push("Customer");
    if (!technician) missingRequired.push("Technician");
    if (!branch)     missingRequired.push("Branch");
    if (missingRequired.length) {
      alert("Please select the following before submitting:\n\n- " + missingRequired.join("\n- "));
      return;
    }

    var customerClean   = customer;
    var technicianClean = technician; // now plain text
    var branchClean     = branch;

    // Currency: parse UI string to number (or null)
    var amountInput = q("#amount");
    var amountParsed = amountInput ? parseCurrencyInput(amountInput.value) : null;

    // Resolve linked record IDs in parallel (Customer + Branch only)
    var ids = await Promise.all([
      findRecordId(CUSTOMER_TABLE, "Client Name", customerClean),
      /* technician no longer looked up */
      findRecordId(BRANCH_TABLE,   "Office Name", branchClean)
    ]);

    var custId   = ids[0];
    var branchId = ids[1];

    var missing = [];
    if (!custId)   missing.push('Customer: "' + (customerClean || "(empty)") + '"');
    if (!branchId) missing.push('Branch: "' + (branchClean || "(empty)") + '"');

    if (missing.length) {
      alert(
        "Couldn't find the following in Airtable (check exact spelling / renamed fields?):\n\n" +
        missing.join("\n") +
        "\n\nNote: lookups are case/space-insensitive (LOWER/TRIM). If it still fails, the value likely doesn't exist in the referenced table."
      );
      return;
    }

    // ⬇️ Upload photos to Dropbox and prepare Airtable attachments
    var photoAttachments = [];
    try {
      photoAttachments = await uploadPhotosAndGetAttachments();
    } catch (upErr) {
      console.error("Photo upload error:", upErr);
      alert("One or more photos failed to upload. You can submit without photos or try again.");
      // continue; attachments can be empty
    }

    var fields = {
      "Customer":     [custId],
      // "Tech name" is a plain text field
      "Tech name":    (technicianClean && technicianClean.trim()) ? technicianClean.trim() : undefined,
      "Vanir Branch": [branchId],
      "Job Name":     (jobName && jobName.trim()) ? jobName.trim() : undefined,
      "Issue":        (reason && reason.trim()) ? reason.trim() : undefined
    };

    // Only include Backcharge Amount if user provided a number
    if (amountParsed !== null) {
      fields["Backcharge Amount"] = amountParsed; // Airtable number field
    }

    if (photoAttachments.length) {
      fields["Photos"] = photoAttachments; // Attachment field expects [{ url, filename }]
    }

    var payload = { fields: fields };

    try {
      var res = await fetch("https://api.airtable.com/v0/" + BASE_ID + "/" + TABLE_ID, {
        method: "POST",
        headers: atHeaders(),
        body: JSON.stringify(payload)
      });

      var body = {};
      try { body = await res.json(); } catch (e2) {}

      if (!res.ok) {
        console.error("Create backcharge failed:", { status: res.status, body: body, payload: payload });
        alert(
          "Error submitting backcharge (HTTP " + res.status + ").\n\n" +
          (body && body.error && body.error.message ? body.error.message : JSON.stringify(body, null, 2)) +
          "\n\nCheck console for details."
        );
        return;
      }

      alert("Backcharge submitted!");
      formEl.reset();

      // Optional: clear file input value explicitly
      var fileEl = document.getElementById("photos");
      if (fileEl) { try { fileEl.value = ""; } catch (e3) {} }

      // Reformat currency after reset (since reset clears the field)
      attachCurrencyBehaviors(document.getElementById("amount"));

      // Rebuild dropdowns after reset (optional; keeps lists fresh)
      var branchNameAfter = val("#branch");
      if (branchNameAfter) {
        populateSelectFromArray(customerRecords, "Client Name", "customer", branchNameAfter, "Division");
        populateSelectFromArray(techRecords,     "Full Name",   "technician", branchNameAfter, "Vanir Office");
      } else {
        populateSelectFromArray(customerRecords, "Client Name", "customer", null, "Division");
        populateSelectFromArray(techRecords,     "Full Name",   "technician", null, "Vanir Office");
      }
    } catch (err) {
      console.error("Submit exception:", err);
      alert("Network or script error. See console.");
    }
  });
}

// ---- Bootstrap ----
initDropdowns().catch(function(err){ console.error("initDropdowns exception:", err); });
