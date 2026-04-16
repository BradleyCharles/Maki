// ── State ─────────────────────────────────────────────────────────────────────
let username = "";
let isGenerating = false;
let settings = {};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const nameOverlay   = $("name-overlay");
const nameInput     = $("name-input");
const nameSubmit    = $("name-submit");
const app           = $("app");
const messages      = $("messages");
const messageInput  = $("message-input");
const sendBtn       = $("send-btn");
const sidebarEl     = $("sidebar");
const sidebarToggle  = $("sidebar-toggle");
const changeUserBtn  = $("change-user-btn");
const statusDot      = $("status-dot");

// Sidebar controls
const sOllamaUrl     = $("s-ollama-url");
const sModel         = $("s-model");
const sApplyModel    = $("s-apply-model");
const sTemperature   = $("s-temperature");
const sTopP          = $("s-top_p");
const sTopK          = $("s-top_k");
const sRepeatPenalty = $("s-repeat_penalty");
const sNumPredict    = $("s-num_predict");
const sShowThinking  = $("s-show-thinking");
const sApplySampling = $("s-apply-sampling");

const dUsername     = $("d-username");
const dFamiliarity  = $("d-familiarity");
const dHistory      = $("d-history");
const dLastseen     = $("d-lastseen");
const dResponseTime = $("d-response-time");
const dLoop         = $("d-loop");
const dUserFacts    = $("d-user-facts");
const dMakiFacts    = $("d-maki-facts");
const btnClearHistory = $("btn-clear-history");
const btnClearMemory  = $("btn-clear-memory");
const btnRefreshMemory = $("btn-refresh-memory");

// ── Name entry ────────────────────────────────────────────────────────────────
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") startSession();
});
nameSubmit.addEventListener("click", startSession);

// Load existing users into the sign-in list
async function loadUserList() {
  try {
    const res = await fetch("/api/users");
    const users = await res.json();
    if (!users.length) return;

    const listEl  = $("user-list");
    const itemsEl = $("user-list-items");
    listEl.hidden = false;

    for (const u of users) {
      const btn = document.createElement("button");
      btn.className = "user-list-btn";

      const nameSpan = document.createElement("span");
      nameSpan.className = "ulb-name";
      nameSpan.textContent = u.displayName;

      const metaSpan = document.createElement("span");
      metaSpan.className = "ulb-meta";
      metaSpan.textContent = u.lastSeen
        ? new Date(u.lastSeen).toLocaleDateString()
        : "new";

      btn.appendChild(nameSpan);
      btn.appendChild(metaSpan);
      btn.addEventListener("click", () => {
        nameInput.value = u.displayName;
        startSession();
      });
      itemsEl.appendChild(btn);
    }
  } catch {}
}
loadUserList();

async function startSession() {
  const name = nameInput.value.trim();
  if (!name) return;
  username = name;
  nameOverlay.style.display = "none";
  app.hidden = false;
  dUsername.textContent = username;

  await loadSettings();
  await loadModels();
  await refreshSessionStats();
  await refreshMemory();
  checkOllamaStatus();

  // Add a return note if this user has prior history
  try {
    const res = await postNote("return");
    if (res) {
      const data = await res.json();
      if (data.ok && !data.skipped && data.duration) {
        addSystemMsg(`You were away for ${data.duration}.`);
        await refreshSessionStats();
      }
    }
  } catch {}

  messageInput.focus();
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    settings = await res.json();
    applySettingsToUI();
  } catch {}
}

function applySettingsToUI() {
  sOllamaUrl.value = settings.ollamaUrl ?? "";
  sShowThinking.checked = settings.showThinking ?? false;

  const opts = settings.chatOptions ?? {};
  setSlider(sTemperature,   $("v-temperature"),   opts.temperature,   2);
  setSlider(sTopP,          $("v-top_p"),          opts.top_p,         2);
  setSlider(sTopK,          $("v-top_k"),          opts.top_k,         0);
  setSlider(sRepeatPenalty, $("v-repeat_penalty"), opts.repeat_penalty, 2);
  setSlider(sNumPredict,    $("v-num_predict"),    opts.num_predict,   0);
}

function setSlider(input, label, value, decimals) {
  if (value == null) return;
  input.value = value;
  label.textContent = Number(value).toFixed(decimals);
}

// Live slider value display
function wireSlider(input, label, decimals) {
  input.addEventListener("input", () => {
    label.textContent = Number(input.value).toFixed(decimals);
  });
}
wireSlider(sTemperature,   $("v-temperature"),   2);
wireSlider(sTopP,          $("v-top_p"),          2);
wireSlider(sTopK,          $("v-top_k"),          0);
wireSlider(sRepeatPenalty, $("v-repeat_penalty"), 2);
wireSlider(sNumPredict,    $("v-num_predict"),    0);

sApplyModel.addEventListener("click", async () => {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ollamaUrl: sOllamaUrl.value.trim(),
      model: sModel.value,
    }),
  });
  settings.ollamaUrl = sOllamaUrl.value.trim();
  settings.model = sModel.value;
  checkOllamaStatus();
  addSystemMsg("Model settings applied.");
});

sApplySampling.addEventListener("click", async () => {
  const chatOptions = {
    temperature:   Number(sTemperature.value),
    top_p:         Number(sTopP.value),
    top_k:         Number(sTopK.value),
    repeat_penalty: Number(sRepeatPenalty.value),
    num_predict:   Number(sNumPredict.value),
  };
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatOptions, showThinking: sShowThinking.checked }),
  });
  settings.chatOptions = chatOptions;
  settings.showThinking = sShowThinking.checked;
  addSystemMsg("Sampling parameters applied.");
});

// ── Models ────────────────────────────────────────────────────────────────────
function setStatus(state) {
  statusDot.className = state;
  statusDot.setAttribute("aria-label",
    state === "ok"  ? "Ollama: connected" :
    state === "err" ? "Ollama: disconnected" : "Ollama: checking"
  );
}

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) { setStatus("err"); return; }
    const models = await res.json();
    setStatus("ok");
    sModel.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = opt.textContent = m;
      if (m === settings.model) opt.selected = true;
      sModel.appendChild(opt);
    }
  } catch {
    setStatus("err");
  }
}

async function checkOllamaStatus() {
  try {
    const res = await fetch("/api/models");
    setStatus(res.ok ? "ok" : "err");
    if (res.ok) await loadModels();
  } catch {
    setStatus("err");
  }
}

// ── Session stats ─────────────────────────────────────────────────────────────
async function refreshSessionStats() {
  try {
    const res = await fetch(`/api/memory/${encodeURIComponent(username)}`);
    const data = await res.json();
    dFamiliarity.textContent = `${data.familiarity} pts`;
    dHistory.textContent     = `${data.historyCount} msgs`;
    dLastseen.textContent    = data.lastSeen
      ? new Date(data.lastSeen).toLocaleString()
      : "never";
  } catch {}
}

async function refreshMemory() {
  try {
    const [userRes, makiRes] = await Promise.all([
      fetch(`/api/memory/${encodeURIComponent(username)}`),
      fetch("/api/memory/maki"),
    ]);
    const userData = await userRes.json();
    const makiData = await makiRes.json();
    dUserFacts.textContent = userData.facts?.trim() || "(none yet)";
    dMakiFacts.textContent = makiData.facts?.trim() || "(none yet)";
  } catch {}
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
sidebarToggle.addEventListener("click", () => {
  sidebarEl.classList.toggle("hidden");
});

// ── Change user ───────────────────────────────────────────────────────────────
changeUserBtn.addEventListener("click", async () => {
  if (isGenerating) return;
  await postNote("leave");
  username = "";
  messages.innerHTML = "";
  nameInput.value = "";
  app.hidden = true;
  nameOverlay.style.display = "";
  // Refresh user list in case new users were created this session
  $("user-list-items").innerHTML = "";
  $("user-list").hidden = true;
  loadUserList();
  nameInput.focus();
});

// ── Presence tracking ─────────────────────────────────────────────────────────
function postNote(type) {
  if (!username) return Promise.resolve(null);
  return fetch(`/api/memory/${encodeURIComponent(username)}/note`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, username }),
  }).catch(() => null);
}

// Use sendBeacon on page close — it fires even as the page unloads
window.addEventListener("pagehide", () => {
  if (!username) return;
  const data = JSON.stringify({ type: "leave", username });
  navigator.sendBeacon(
    `/api/memory/${encodeURIComponent(username)}/note`,
    new Blob([data], { type: "application/json" })
  );
});

// ── Session actions ───────────────────────────────────────────────────────────
btnClearHistory.addEventListener("click", async () => {
  if (!confirm("Clear conversation history?")) return;
  await fetch(`/api/memory/${encodeURIComponent(username)}/history`, { method: "DELETE" });
  addSystemMsg("Conversation history cleared.");
  await refreshSessionStats();
});

btnClearMemory.addEventListener("click", async () => {
  if (!confirm("Clear all memory for this user? This cannot be undone.")) return;
  await fetch(`/api/memory/${encodeURIComponent(username)}`, { method: "DELETE" });
  addSystemMsg("User memory cleared.");
  await refreshSessionStats();
  await refreshMemory();
});

btnRefreshMemory.addEventListener("click", async () => {
  await refreshMemory();
  addSystemMsg("Memory refreshed.");
});

// ── Chat ──────────────────────────────────────────────────────────────────────
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
});

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isGenerating) return;

  isGenerating = true;
  sendBtn.disabled = true;
  messageInput.disabled = true;
  messageInput.value = "";
  messageInput.style.height = "auto";

  // Add user message
  addMessage("user", username, text);

  // Add Maki typing indicator
  const typingEl = addTyping();

  // Placeholders for streaming
  let makiMsgEl = null;
  let makiBubble = null;
  let thinkEl = null;
  let thinkBubble = null;
  let hasThinking = false;

  dResponseTime.textContent = "…";
  dLoop.textContent = "—";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, message: text }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        handleEvent(event);
      }
    }

    // Process any remaining line
    if (lineBuffer.startsWith("data: ")) {
      try { handleEvent(JSON.parse(lineBuffer.slice(6))); } catch {}
    }

  } catch (err) {
    typingEl?.remove();
    addSystemMsg(`Error: ${err.message}`);
  } finally {
    isGenerating = false;
    sendBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }

  function handleEvent(event) {
    if (event.type === "think") {
      typingEl.style.display = "none";
      if (!hasThinking) {
        hasThinking = true;
        // Create Maki message with thinking block
        const { msgEl, bubble, thinkContainer, thinkContent } = addMakiMessageWithThink();
        makiMsgEl = msgEl;
        makiBubble = bubble;
        thinkEl = thinkContainer;
        thinkBubble = thinkContent;
      }
      thinkBubble.textContent += event.content;
      thinkEl.scrollTop = thinkEl.scrollHeight;
    }

    else if (event.type === "token") {
      typingEl.style.display = "none";
      if (!makiBubble) {
        if (hasThinking) {
          // bubble already created, just append
        } else {
          const { msgEl, bubble } = addMakiMessage();
          makiMsgEl = msgEl;
          makiBubble = bubble;
        }
      }
      if (makiBubble) {
        makiBubble.textContent += event.content;
        scrollToBottom();
      }
    }

    else if (event.type === "loop_detected") {
      addSystemMsg("Loop detected — self-correcting…");
    }

    else if (event.type === "correction") {
      // Replace the streamed content with corrected reply
      if (makiBubble) makiBubble.textContent = event.content;
    }

    else if (event.type === "done") {
      typingEl.remove();
      dResponseTime.textContent = `${(event.responseTime / 1000).toFixed(1)}s`;
      if (event.loopDetected) {
        dLoop.innerHTML = event.loopCorrected
          ? `<span class="loop-badge corrected">corrected</span>`
          : `<span class="loop-badge detected">detected</span>`;
      } else {
        dLoop.textContent = "none";
      }
      dFamiliarity.textContent = `${event.familiarity} pts`;
      dHistory.textContent     = `${event.historyCount} msgs`;
      scrollToBottom();
    }

    else if (event.type === "error") {
      typingEl.remove();
      addSystemMsg(`Error: ${event.message}`);
    }
  }
}

// ── Message builders ──────────────────────────────────────────────────────────
function addMessage(role, label, text) {
  const msg = document.createElement("div");
  msg.className = `msg ${role}`;

  const lbl = document.createElement("div");
  lbl.className = "msg-label";
  lbl.textContent = label;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text;

  msg.appendChild(lbl);
  msg.appendChild(bubble);
  messages.appendChild(msg);
  scrollToBottom();
  return { msgEl: msg, bubble };
}

function addMakiMessage() {
  const msg = document.createElement("div");
  msg.className = "msg maki";

  const lbl = document.createElement("div");
  lbl.className = "msg-label";
  lbl.textContent = "Maki";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  msg.appendChild(lbl);
  msg.appendChild(bubble);
  messages.appendChild(msg);
  scrollToBottom();
  return { msgEl: msg, bubble };
}

function addMakiMessageWithThink() {
  const msg = document.createElement("div");
  msg.className = "msg maki";

  const lbl = document.createElement("div");
  lbl.className = "msg-label";
  lbl.textContent = "Maki";

  const thinkContainer = document.createElement("div");
  thinkContainer.className = "think-block";
  const thinkLabel = document.createElement("div");
  thinkLabel.className = "think-label";
  thinkLabel.textContent = "thinking…";
  const thinkContent = document.createElement("div");
  thinkContainer.appendChild(thinkLabel);
  thinkContainer.appendChild(thinkContent);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  msg.appendChild(lbl);
  msg.appendChild(thinkContainer);
  msg.appendChild(bubble);
  messages.appendChild(msg);
  scrollToBottom();
  return { msgEl: msg, bubble, thinkContainer, thinkContent };
}

function addTyping() {
  const msg = document.createElement("div");
  msg.className = "msg maki";

  const lbl = document.createElement("div");
  lbl.className = "msg-label";
  lbl.textContent = "Maki";

  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("div");
    dot.className = "typing-dot";
    indicator.appendChild(dot);
  }

  msg.appendChild(lbl);
  msg.appendChild(indicator);
  messages.appendChild(msg);
  scrollToBottom();
  return msg;
}

function addSystemMsg(text) {
  const el = document.createElement("div");
  el.className = "msg-system";
  el.textContent = text;
  messages.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
}
