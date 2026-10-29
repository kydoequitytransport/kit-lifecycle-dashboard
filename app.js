"use strict";

const DAY_MS = 86_400_000;
const EXPORT_AS_OF = "2026-10-20";
const PAGE_SIZE = 8;
const ORDER_PAGE_SIZE = 10;

const STAGES = [
  { key: "kit_shipped", label: "Kit shipped", short: "Order → shipped", target: 3, color: "#7775e4" },
  { key: "kit_delivered", label: "Kit delivered", short: "Shipped → delivered", target: 7, color: "#5c9fe5" },
  { key: "sample_mailed", label: "Sample mailed", short: "Delivered → mailed", target: 45, color: "#52b7a3" },
  { key: "sample_received", label: "Sample received", short: "Mailed → received", target: 14, color: "#e6ac50" },
  { key: "qc_passed", label: "QC result", short: "Received → QC result", target: 7, color: "#dc8960" },
  { key: "sequencing_complete", label: "Sequencing complete", short: "QC passed → sequencing", target: 28, color: "#8a78d5" },
  { key: "report_ready", label: "Report ready", short: "Sequencing → report", target: 5, color: "#49ad8c" },
];
const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage.key, index]));
const PIPELINE_LABELS = {
  order_placed: "Order placed",
  kit_shipped: "Kit shipped",
  kit_delivered: "Kit delivered",
  sample_mailed: "Sample mailed",
  sample_received: "Sample received",
  qc_passed: "QC passed",
  qc_failed: "QC failed",
  sequencing_complete: "Sequencing",
  report_ready: "Report ready",
};
const PIPELINE_COLORS = {
  order_placed: "#b8bdca",
  kit_shipped: "#7775e4",
  kit_delivered: "#5c9fe5",
  sample_mailed: "#52b7a3",
  sample_received: "#e6ac50",
  qc_passed: "#dc8960",
  qc_failed: "#df7164",
  sequencing_complete: "#8a78d5",
  report_ready: "#49ad8c",
};
const ORDER_HEADERS = ["order_id", "created_at", "customer_id", "product", "country", "status", "is_test"];
const EVENT_HEADERS = ["event_id", "order_id", "kit_id", "event_type", "occurred_at", "source"];

const state = {
  orders: [],
  events: [],
  kits: [],
  ordersById: new Map(),
  eventsByOrder: new Map(),
  kitsByOrder: new Map(),
  selectedOrders: [],
  filteredKits: [],
  attention: [],
  diagnostics: { duplicates: 0, orphans: 0, invalid: 0 },
  asOf: new Date(`${EXPORT_AS_OF}T23:59:59Z`),
  currentPage: 0,
  showAllAttention: false,
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const numberFormat = new Intl.NumberFormat("en-US");

function parseTimestamp(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized);
  const timestamp = Date.parse(hasZone ? normalized : `${normalized}Z`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatDate(timestamp, options = {}) {
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC", ...options }).format(timestamp);
}

function formatDateTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(timestamp);
}

function dayString(timestamp) {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function elapsedDays(from, to) {
  return Math.max(0, (to - from) / DAY_MS);
}

function displayDays(days) {
  if (!Number.isFinite(days)) return "—";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.round(days)}d`;
}

function csvToRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const source = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  if (rows.length < 1) throw new Error("CSV is empty.");
  const headers = rows[0].map((header) => header.trim());
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (duplicateHeaders.length) throw new Error(`CSV has duplicate column names: ${[...new Set(duplicateHeaders)].join(", ")}.`);
  const records = rows.slice(1).map((cells, rowIndex) => {
    if (cells.length !== headers.length) throw new Error(`Row ${rowIndex + 2} has ${cells.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index].trim()]));
  }).filter((record) => Object.values(record).some((cell) => cell !== ""));
  records.headers = headers;
  return records;
}

function validateColumns(records, required, fileLabel) {
  const headers = records.headers || Object.keys(records[0] || {});
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`${fileLabel} is missing required columns: ${missing.join(", ")}.`);
}

function readCsvFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

function parseCsvWithHeaders(text) {
  return csvToRows(text);
}

function buildDataset(orderRows, eventRows) {
  validateColumns(orderRows, ORDER_HEADERS, "orders.csv");
  validateColumns(eventRows, EVENT_HEADERS, "kit_events.csv");
  const diagnostics = { duplicates: 0, orphans: 0, invalid: 0 };
  const orders = [];
  const ordersById = new Map();
  for (const row of orderRows) {
    const createdAt = parseTimestamp(row.created_at);
    if (!row.order_id || !createdAt || !row.product || !row.country || !row.status) {
      diagnostics.invalid += 1;
      continue;
    }
    if (ordersById.has(row.order_id)) {
      diagnostics.invalid += 1;
      continue;
    }
    const order = { ...row, createdAt, isTest: row.is_test.toLowerCase() === "true" };
    orders.push(order);
    ordersById.set(order.order_id, order);
  }

  const uniqueEvents = [];
  const seen = new Set();
  for (const row of eventRows) {
    const occurredAt = parseTimestamp(row.occurred_at);
    if (!row.event_id || !row.order_id || !row.kit_id || !row.event_type || !occurredAt) {
      diagnostics.invalid += 1;
      continue;
    }
    if (!ordersById.has(row.order_id)) {
      diagnostics.orphans += 1;
      continue;
    }
    const signature = `${row.order_id}\u0000${row.kit_id}\u0000${row.event_type}\u0000${occurredAt}`;
    if (seen.has(signature)) {
      diagnostics.duplicates += 1;
      continue;
    }
    seen.add(signature);
    uniqueEvents.push({ ...row, occurredAt });
  }

  const eventsByOrder = new Map();
  const eventsByKit = new Map();
  for (const event of uniqueEvents) {
    if (!eventsByOrder.has(event.order_id)) eventsByOrder.set(event.order_id, []);
    eventsByOrder.get(event.order_id).push(event);
    const key = `${event.order_id}\u0000${event.kit_id}`;
    if (!eventsByKit.has(key)) eventsByKit.set(key, []);
    eventsByKit.get(key).push(event);
  }

  const kits = [];
  for (const [key, events] of eventsByKit) {
    events.sort((left, right) => left.occurredAt - right.occurredAt || left.event_id.localeCompare(right.event_id));
    const order = ordersById.get(events[0].order_id);
    const replacements = events.filter((event) => event.event_type === "kit_replaced");
    const stageEvents = events.filter((event) => STAGE_INDEX.has(event.event_type) || event.event_type === "qc_failed");
    const latestStageEvent = stageEvents.at(-1) || null;
    const milestones = new Map();
    for (const event of stageEvents) {
      if (event.event_type !== "qc_failed") milestones.set(event.event_type, event.occurredAt);
    }
    const kit = {
      key,
      order,
      kitId: events[0].kit_id,
      events,
      latestStageEvent,
      milestones,
      isReplaced: replacements.length > 0,
      replacedAt: replacements.at(-1)?.occurredAt ?? null,
      stage: latestStageEvent?.event_type || "order_placed",
      stageAt: latestStageEvent?.occurredAt ?? order.createdAt,
      isQcFailed: latestStageEvent?.event_type === "qc_failed",
    };
    kits.push(kit);
  }

  const kitsByOrder = new Map();
  for (const kit of kits) {
    if (!kitsByOrder.has(kit.order.order_id)) kitsByOrder.set(kit.order.order_id, []);
    kitsByOrder.get(kit.order.order_id).push(kit);
  }
  for (const order of orders) {
    if (!kitsByOrder.has(order.order_id) && order.product !== "upload_only") {
      const kit = {
        key: `${order.order_id}\u0000no-kit-event`,
        order,
        kitId: null,
        events: [],
        latestStageEvent: null,
        milestones: new Map(),
        isReplaced: false,
        replacedAt: null,
        stage: "order_placed",
        stageAt: order.createdAt,
        isQcFailed: false,
      };
      kits.push(kit);
      kitsByOrder.set(order.order_id, [kit]);
    }
  }

  const latestEvent = uniqueEvents.reduce((latest, event) => Math.max(latest, event.occurredAt), 0);
  const latestOrder = orders.reduce((latest, order) => Math.max(latest, order.createdAt), 0);
  return {
    orders,
    events: uniqueEvents,
    kits,
    ordersById,
    eventsByOrder,
    kitsByOrder,
    diagnostics,
    latestTimestamp: Math.max(latestEvent, latestOrder),
  };
}

function eligibleOrder(order) {
  return order.status === "paid" && !order.isTest && order.product !== "upload_only";
}

function findStageDuration(kit, stageKey) {
  const milestoneIndex = STAGE_INDEX.get(stageKey);
  if (milestoneIndex === undefined) return null;
  const milestone = kit.milestones.get(stageKey);
  if (!Number.isFinite(milestone)) return null;
  const previousTime = milestoneIndex === 0
    ? kit.order.createdAt
    : kit.milestones.get(STAGES[milestoneIndex - 1].key);
  if (!Number.isFinite(previousTime)) return null;
  const difference = (milestone - previousTime) / DAY_MS;
  return difference >= 0 ? difference : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getTargetForKit(kit) {
  if (kit.isQcFailed) return { target: 0, stageLabel: "QC failed" };
  if (kit.stage === "report_ready") return null;
  if (kit.stage === "order_placed") return { target: STAGES[0].target, stageLabel: "Order placed" };
  const stageIndex = STAGE_INDEX.get(kit.stage);
  if (stageIndex === undefined) return null;
  const nextStage = STAGES[stageIndex + 1];
  if (!nextStage) return null;
  return { target: nextStage.target, stageLabel: PIPELINE_LABELS[kit.stage] || kit.stage };
}

function getDelay(kit) {
  const info = getTargetForKit(kit);
  if (!info) return null;
  const waitingDays = elapsedDays(kit.stageAt, state.asOf.getTime());
  return { ...info, waitingDays, overdueDays: Math.max(0, waitingDays - info.target), isOverdue: kit.isQcFailed || waitingDays > info.target };
}

function getVisibleOrders() {
  const from = $("#date-from").value;
  const to = $("#date-to").value;
  const product = $("#product-filter").value;
  const country = $("#country-filter").value;
  return state.orders.filter((order) => {
    if (!eligibleOrder(order)) return false;
    const createdDay = dayString(order.createdAt);
    if (from && createdDay < from) return false;
    if (to && createdDay > to) return false;
    if (product && order.product !== product) return false;
    if (country && order.country !== country) return false;
    return true;
  });
}

function getPipelineData(kits) {
  const counts = new Map();
  for (const kit of kits) {
    if (kit.isReplaced) continue;
    const stage = kit.stage;
    counts.set(stage, (counts.get(stage) || 0) + 1);
  }
  return counts;
}

function renderPipeline(kits) {
  const counts = getPipelineData(kits);
  const keys = ["order_placed", "kit_shipped", "kit_delivered", "sample_mailed", "sample_received", "qc_passed", "qc_failed", "sequencing_complete", "report_ready"];
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  $("#pipeline-total").textContent = `${numberFormat.format(total)} kits`;
  $("#pipeline-chart").innerHTML = total
    ? keys.filter((key) => counts.has(key)).map((key) => `<div class="pipe-segment" style="width:${(counts.get(key) / total) * 100}%;background:${PIPELINE_COLORS[key]}" data-tip="${escapeHtml(PIPELINE_LABELS[key])}: ${numberFormat.format(counts.get(key))}" title="${escapeHtml(PIPELINE_LABELS[key])}: ${numberFormat.format(counts.get(key))}"></div>`).join("")
    : `<div class="pipe-segment" style="width:100%;background:#e8eaf0" data-tip="No kits match these filters"></div>`;
  $("#pipeline-legend").innerHTML = keys.filter((key) => counts.has(key)).map((key) => `
    <div class="legend-item"><span class="legend-square" style="background:${PIPELINE_COLORS[key]}"></span><span class="legend-name">${escapeHtml(PIPELINE_LABELS[key])}</span><strong class="legend-value">${numberFormat.format(counts.get(key))}</strong></div>
  `).join("") || `<div class="table-empty">No kits match these filters.</div>`;
}

function stageDurations(kits) {
  const results = new Map();
  for (const stage of STAGES) {
    const durationByProduct = new Map();
    for (const kit of kits) {
      if (kit.isReplaced) continue;
      const value = findStageDuration(kit, stage.key);
      if (value === null) continue;
      if (!durationByProduct.has(kit.order.product)) durationByProduct.set(kit.order.product, []);
      durationByProduct.get(kit.order.product).push(value);
    }
    const values = [...durationByProduct.values()].flat();
    results.set(stage.key, {
      overall: median(values),
      products: new Map([...durationByProduct].map(([product, durations]) => [product, median(durations)])),
    });
  }
  return results;
}

function renderStageChart(kits) {
  const stats = stageDurations(kits);
  const maxValue = Math.max(...STAGES.map((stage) => stage.target), ...STAGES.map((stage) => stats.get(stage.key).overall || 0), 1);
  $("#stage-chart").innerHTML = STAGES.map((stage) => {
    const actual = stats.get(stage.key).overall;
    const width = actual === null ? 0 : Math.min(100, (actual / maxValue) * 100);
    const targetPos = Math.min(100, (stage.target / maxValue) * 100);
    return `<div class="stage-row">
      <span class="stage-label" title="${escapeHtml(stage.short)}">${escapeHtml(stage.short)}</span>
      <span class="bar-track" aria-label="${actual === null ? "No completed data" : `Median ${actual.toFixed(1)} days; target ${stage.target} days`}"><i class="bar-target" style="left:${targetPos}%"></i><i class="bar-actual" style="width:${width}%"></i></span>
      <span class="stage-days ${actual === null ? "empty" : ""}">${actual === null ? "—" : `${actual.toFixed(1)}d`}</span>
    </div>`;
  }).join("");

  const products = [...new Set(kits.map((kit) => kit.order.product))].sort();
  const head = $("#product-table-head");
  head.innerHTML = `<th>STAGE</th>${products.map((product) => `<th>${escapeHtml(product.replaceAll("_", " ").toUpperCase())}</th>`).join("")}`;
  $("#product-table-body").innerHTML = STAGES.map((stage) => {
    const productCells = products.map((product) => {
      const value = stats.get(stage.key).products.get(product);
      return `<td>${value === undefined ? `<span class="comparison-empty">—</span>` : `<span class="comparison-value">${value.toFixed(1)}d</span><span class="comparison-target">/ ${stage.target}d</span>`}</td>`;
    }).join("");
    return `<tr><td><span class="comparison-stage"><i style="background:${stage.color}"></i>${escapeHtml(stage.short)}</span></td>${productCells}</tr>`;
  }).join("");
}

function renderAttention(kits) {
  const filtered = kits.filter((kit) => !kit.isReplaced).map((kit) => ({ kit, delay: getDelay(kit) })).filter(({ delay }) => delay?.isOverdue);
  filtered.sort((left, right) => right.delay.overdueDays - left.delay.overdueDays || left.kit.stageAt - right.kit.stageAt);
  state.attention = filtered;
  const search = $("#order-search").value.trim().toLowerCase();
  const matches = filtered.filter(({ kit }) => !search
    || kit.order.order_id.toLowerCase().includes(search)
    || (kit.kitId || "").toLowerCase().includes(search));
  const display = state.showAllAttention ? matches : matches.slice(0, PAGE_SIZE);
  $("#metric-stuck").textContent = numberFormat.format(filtered.length);
  $("#attention-count").textContent = numberFormat.format(filtered.length);
  $("#nav-attention-count").textContent = filtered.length > 99 ? "99+" : numberFormat.format(filtered.length);
  $("#overdue-caption").textContent = filtered.length === 1 ? "Kit beyond stage target" : "Kits beyond stage target";
  $("#attention-table-caption").textContent = filtered.length
    ? `Showing ${display.length ? 1 : 0}–${Math.min(display.length, matches.length)} of ${numberFormat.format(matches.length)} matching kits`
    : "No kits currently need follow-up";
  $("#show-all-stuck").classList.toggle("hidden", matches.length <= PAGE_SIZE);
  $("#show-all-stuck").textContent = state.showAllAttention ? "Show fewer ↑" : "Show all →";
  $("#attention-empty").classList.toggle("hidden", display.length > 0);
  $("#attention-empty").textContent = search && !matches.length ? "No kits match that search." : "Nothing overdue in this filtered view. Nice work.";
  $("#attention-table-body").innerHTML = display.map(({ kit, delay }) => `
    <tr>
      <td><div class="order-cell"><button class="order-link" data-order="${escapeHtml(kit.order.order_id)}">${escapeHtml(kit.order.order_id)}</button><small>${escapeHtml(kit.kitId || "Kit not shipped")}</small></div></td>
      <td>${escapeHtml(kit.order.product.replaceAll("_", " "))}</td>
      <td>${escapeHtml(kit.order.country)}</td>
      <td><span class="stage-badge ${kit.isQcFailed ? "stage-qc_failed" : ""}">${escapeHtml(delay.stageLabel)}</span></td>
      <td>${displayDays(delay.waitingDays)}</td>
      <td class="${delay.isQcFailed ? "overdue-text" : "overdue-text"}">${delay.isQcFailed ? "QC failed" : `+${displayDays(delay.overdueDays)}`}</td>
      <td><button class="detail-button" data-order="${escapeHtml(kit.order.order_id)}" aria-label="View order ${escapeHtml(kit.order.order_id)}">›</button></td>
    </tr>
  `).join("");
}

function countCurrentKits(order) {
  const kits = (state.kitsByOrder.get(order.order_id) || []).filter((kit) => !kit.isReplaced);
  return kits.length;
}

function renderOrders(orders) {
  const search = $("#recent-search").value.trim().toLowerCase();
  const searched = orders.filter((order) => order.order_id.toLowerCase().includes(search));
  searched.sort((left, right) => right.createdAt - left.createdAt);
  const pageCount = Math.max(1, Math.ceil(searched.length / ORDER_PAGE_SIZE));
  state.currentPage = Math.min(state.currentPage, pageCount - 1);
  const pageOrders = searched.slice(state.currentPage * ORDER_PAGE_SIZE, (state.currentPage + 1) * ORDER_PAGE_SIZE);
  $("#orders-table-body").innerHTML = pageOrders.map((order) => {
    const kits = (state.kitsByOrder.get(order.order_id) || []).filter((kit) => !kit.isReplaced);
    const completed = kits.length > 0 && kits.every((kit) => kit.stage === "report_ready");
    const status = completed ? "Report ready" : kits.length ? PIPELINE_LABELS[kits[0].stage] || kits[0].stage : "Order placed";
    return `<tr>
      <td><button class="order-link" data-order="${escapeHtml(order.order_id)}">${escapeHtml(order.order_id)}</button></td>
      <td>${formatDate(order.createdAt, { month: "short", day: "numeric" })}</td>
      <td>${escapeHtml(order.product.replaceAll("_", " "))}</td>
      <td>${escapeHtml(order.country)}</td>
      <td>${numberFormat.format(kits.length)}</td>
      <td><span class="stage-badge ${status === "QC failed" ? "stage-qc_failed" : ""}">${escapeHtml(status)}</span></td>
      <td><button class="detail-button" data-order="${escapeHtml(order.order_id)}" aria-label="View order ${escapeHtml(order.order_id)}">›</button></td>
    </tr>`;
  }).join("");
  $("#orders-empty").classList.toggle("hidden", pageOrders.length > 0);
  $("#orders-table-caption").textContent = `Showing ${searched.length ? state.currentPage * ORDER_PAGE_SIZE + 1 : 0}–${Math.min((state.currentPage + 1) * ORDER_PAGE_SIZE, searched.length)} of ${numberFormat.format(searched.length)} orders`;
  $("#page-indicator").textContent = `${state.currentPage + 1} / ${pageCount}`;
  $("#previous-page").disabled = state.currentPage === 0;
  $("#next-page").disabled = state.currentPage >= pageCount - 1;
}

function renderMetrics(orders, kits) {
  const currentKits = kits.filter((kit) => !kit.isReplaced);
  const completed = currentKits.filter((kit) => kit.stage === "report_ready").length;
  $("#metric-orders").textContent = numberFormat.format(orders.length);
  $("#metric-active").textContent = numberFormat.format(currentKits.length);
  $("#metric-completed").textContent = numberFormat.format(completed);
  $("#completion-rate").textContent = currentKits.length ? `${Math.round((completed / currentKits.length) * 100)}%` : "0%";
  $("#filter-summary").textContent = orders.length === state.orders.filter(eligibleOrder).length
    ? "All eligible orders"
    : `${numberFormat.format(orders.length)} matching orders`;
  $("#snapshot-date-label").textContent = formatDate(state.asOf.getTime(), { month: "short", day: "numeric", year: undefined });
  $("#sidebar-as-of").textContent = formatDate(state.asOf.getTime(), { month: "short", day: "numeric", year: undefined });
  $("#data-quality-summary").textContent = `Data checks: ${numberFormat.format(state.diagnostics.duplicates)} duplicate rows removed · ${numberFormat.format(state.diagnostics.orphans)} orphan events ignored · ${numberFormat.format(state.diagnostics.invalid)} invalid rows skipped`;
}

function renderDashboard() {
  const orders = getVisibleOrders();
  const visibleOrderIds = new Set(orders.map((order) => order.order_id));
  const kits = state.kits.filter((kit) => visibleOrderIds.has(kit.order.order_id));
  state.selectedOrders = orders;
  state.filteredKits = kits;
  renderMetrics(orders, kits);
  renderPipeline(kits);
  renderStageChart(kits);
  renderAttention(kits);
  renderOrders(orders);
}

function populateFilters() {
  const products = [...new Set(state.orders.filter(eligibleOrder).map((order) => order.product))].sort();
  const countries = [...new Set(state.orders.filter(eligibleOrder).map((order) => order.country))].sort();
  $("#product-filter").innerHTML = `<option value="">All products</option>${products.map((product) => `<option value="${escapeHtml(product)}">${escapeHtml(product.replaceAll("_", " "))}</option>`).join("")}`;
  $("#country-filter").innerHTML = `<option value="">All countries</option>${countries.map((country) => `<option value="${escapeHtml(country)}">${escapeHtml(country)}</option>`).join("")}`;
  const dates = state.orders.filter(eligibleOrder).map((order) => order.createdAt);
  $("#date-from").value = dates.length ? dayString(Math.min(...dates)) : "";
  $("#date-to").value = dates.length ? dayString(Math.max(...dates)) : "";
  $("#as-of-date").value = dayString(state.asOf.getTime());
}

function openOrder(orderId) {
  const order = state.ordersById.get(orderId);
  if (!order) return;
  const allEvents = [...(state.eventsByOrder.get(orderId) || [])].sort((left, right) => left.occurredAt - right.occurredAt);
  const kits = state.kitsByOrder.get(orderId) || [];
  const activeKits = kits.filter((kit) => !kit.isReplaced);
  $("#drawer-title").textContent = order.order_id;
  $("#drawer-subtitle").textContent = `${order.product.replaceAll("_", " ")} · ${order.country} · Placed ${formatDate(order.createdAt)}`;
  $("#drawer-summary").innerHTML = [
    ["Order status", order.status],
    ["Customer", order.customer_id || "—"],
    ["Current kits", numberFormat.format(activeKits.length)],
    ["Snapshot", formatDate(state.asOf.getTime())],
  ].map(([label, value]) => `<div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
  $("#drawer-event-count").textContent = `${allEvents.length} events · ${kits.length} kit${kits.length === 1 ? "" : "s"}`;
  $("#drawer-timeline").innerHTML = allEvents.length
    ? allEvents.map((event) => {
      const kind = event.event_type === "kit_replaced" ? "is-replaced" : event.event_type === "qc_failed" ? "is-failed" : "";
      return `<div class="timeline-item ${kind}"><div class="timeline-top"><span class="timeline-event">${escapeHtml(event.event_type.replaceAll("_", " "))}</span><time class="timeline-time">${escapeHtml(formatDateTime(event.occurredAt))}</time></div><div class="timeline-meta">${escapeHtml(event.kit_id)} · ${escapeHtml(event.source || "unknown source")}</div></div>`;
    }).join("")
    : `<div class="table-empty">No kit events recorded for this order yet.</div>`;
  $("#order-modal").classList.remove("hidden");
  $("#close-drawer").focus();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.add("hidden"), 3000);
}

function setDataset(dataset) {
  state.orders = dataset.orders;
  state.events = dataset.events;
  state.kits = dataset.kits;
  state.ordersById = dataset.ordersById;
  state.eventsByOrder = dataset.eventsByOrder;
  state.kitsByOrder = dataset.kitsByOrder;
  state.diagnostics = dataset.diagnostics;
  state.asOf = dataset.isDefault
    ? new Date(`${EXPORT_AS_OF}T23:59:59Z`)
    : new Date(Math.max(Date.now(), dataset.latestTimestamp || Date.now()));
  populateFilters();
  state.currentPage = 0;
  renderDashboard();
}

async function loadDefaultData() {
  const [ordersResponse, eventsResponse] = await Promise.all([
    fetch("./orders.csv"),
    fetch("./kit_events.csv"),
  ]);
  if (!ordersResponse.ok || !eventsResponse.ok) throw new Error("Sample CSVs could not be loaded. Open the dashboard through a local web server, or import both CSV files.");
  const [ordersText, eventsText] = await Promise.all([ordersResponse.text(), eventsResponse.text()]);
  const dataset = buildDataset(parseCsvWithHeaders(ordersText), parseCsvWithHeaders(eventsText));
  dataset.isDefault = true;
  setDataset(dataset);
}

function bindEvents() {
  $("#apply-filters").addEventListener("click", () => {
    if ($("#date-from").value && $("#date-to").value && $("#date-from").value > $("#date-to").value) {
      showToast("Start date must be on or before end date.");
      return;
    }
    const asOf = parseTimestamp($("#as-of-date").value);
    if (!asOf) {
      showToast("Choose a valid snapshot date.");
      return;
    }
    state.asOf = new Date(asOf + DAY_MS - 1000);
    state.currentPage = 0;
    state.showAllAttention = false;
    renderDashboard();
  });
  $("#reset-filters").addEventListener("click", () => {
    populateFilters();
    state.currentPage = 0;
    state.showAllAttention = false;
    renderDashboard();
  });
  $("#order-search").addEventListener("input", () => {
    state.showAllAttention = false;
    renderAttention(state.filteredKits);
  });
  $("#recent-search").addEventListener("input", () => {
    state.currentPage = 0;
    renderOrders(state.selectedOrders);
  });
  $("#previous-page").addEventListener("click", () => {
    state.currentPage = Math.max(0, state.currentPage - 1);
    renderOrders(state.selectedOrders);
  });
  $("#next-page").addEventListener("click", () => {
    state.currentPage += 1;
    renderOrders(state.selectedOrders);
  });
  $("#show-all-stuck").addEventListener("click", () => {
    state.showAllAttention = !state.showAllAttention;
    renderAttention(state.filteredKits);
  });
  document.body.addEventListener("click", (event) => {
    const orderButton = event.target.closest("[data-order]");
    if (orderButton) openOrder(orderButton.dataset.order);
  });
  $("#close-drawer").addEventListener("click", () => $("#order-modal").classList.add("hidden"));
  $("#order-modal").addEventListener("click", (event) => {
    if (event.target === $("#order-modal")) $("#order-modal").classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("#order-modal").classList.add("hidden");
  });
  $("#help-button").addEventListener("click", () => {
    showToast("Paid physical orders only; test, cancelled, refunded, and upload-only orders are excluded. Duplicate events are collapsed, orphan events ignored. Unzoned timestamps are treated as UTC.");
  });
  $("#upload-toggle").addEventListener("click", () => $("#upload-panel").classList.toggle("hidden"));
  $("#cancel-upload").addEventListener("click", () => {
    $("#upload-panel").classList.add("hidden");
    $("#upload-error").classList.add("hidden");
    $("#orders-file").value = "";
    $("#events-file").value = "";
    $("#load-csv-button").disabled = true;
  });
  const updateUploadButton = () => {
    $("#load-csv-button").disabled = !$("#orders-file").files.length || !$("#events-file").files.length;
    $("#upload-error").classList.add("hidden");
  };
  $("#orders-file").addEventListener("change", updateUploadButton);
  $("#events-file").addEventListener("change", updateUploadButton);
  $("#load-csv-button").addEventListener("click", async () => {
    const button = $("#load-csv-button");
    const error = $("#upload-error");
    button.disabled = true;
    button.textContent = "Loading…";
    error.classList.add("hidden");
    try {
      const [ordersText, eventsText] = await Promise.all([
        readCsvFile($("#orders-file").files[0]),
        readCsvFile($("#events-file").files[0]),
      ]);
      const dataset = buildDataset(parseCsvWithHeaders(ordersText), parseCsvWithHeaders(eventsText));
      setDataset(dataset);
      $("#upload-panel").classList.add("hidden");
      $("#orders-file").value = "";
      $("#events-file").value = "";
      showToast(`Loaded ${numberFormat.format(dataset.orders.length)} orders and ${numberFormat.format(dataset.events.length)} valid events.`);
    } catch (loadError) {
      error.textContent = loadError instanceof Error ? loadError.message : "The CSV files could not be loaded.";
      error.classList.remove("hidden");
    } finally {
      button.textContent = "Load data";
      button.disabled = !$("#orders-file").files.length || !$("#events-file").files.length;
    }
  });
}

bindEvents();
loadDefaultData().catch((error) => {
  console.error(error);
  $("#metric-orders").textContent = "—";
  $("#pipeline-chart").innerHTML = `<div class="table-empty">${escapeHtml(error.message)}</div>`;
  showToast(error.message);
});
