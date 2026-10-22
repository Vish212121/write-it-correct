const DEFAULTS = {
  groqApiKey: "",
  model: "qwen/qwen3.8-27b",
  language: "auto",
  disabledSites: [],
  liveCheckEnabled: true,
};

const els = {
  apiKey: document.getElementById("apiKey"),
  toggleKey: document.getElementById("toggleKey"),
  testKey: document.getElementById("testKey"),
  testResult: document.getElementById("testResult"),
  model: document.getElementById("model"),
  language: document.getElementById("language"),
  liveCheck: document.getElementById("liveCheck"),
  newSite: document.getElementById("newSite"),
  addSite: document.getElementById("addSite"),
  siteList: document.getElementById("siteList"),
  save: document.getElementById("save"),
  saveResult: document.getElementById("saveResult"),
};

let disabledSites = [];

function setStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status${kind ? ` ${kind}` : ""}`;
}

function renderSites() {
  els.siteList.replaceChildren();
  for (const site of disabledSites) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = site;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${site} from disabled sites`);
    remove.addEventListener("click", () => {
      disabledSites = disabledSites.filter((candidate) => candidate !== site);
      renderSites();
    });
    item.append(label, remove);
    els.siteList.appendChild(item);
  }
}

function normalizeHostname(value) {
  const input = value.trim();
  if (!input || /\s/.test(input)) return null;
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function getModel() {
  const model = els.model.value.trim();
  if (!model || model.length > 128 || !/^[A-Za-z0-9._:\/-]+$/.test(model)) {
    throw new Error("Enter a valid Groq model ID.");
  }
  return model;
}

function isLegacyModelId(value) {
  return /^(?:gemini|gpt-|o[134](?:-|$)|chatgpt-)/i.test(value);
}

async function load() {
  try {
    const stored = await chrome.storage.local.get(DEFAULTS);
    // Provider credentials are never carried across provider changes.
    await chrome.storage.local.remove(["apiKey", "openAiApiKey"]);
    els.apiKey.value = stored.groqApiKey || "";
    els.model.value = typeof stored.model === "string" && !isLegacyModelId(stored.model)
      ? stored.model
      : DEFAULTS.model;
    els.language.value = stored.language || "auto";
    els.liveCheck.checked = stored.liveCheckEnabled !== false;
    disabledSites = Array.isArray(stored.disabledSites)
      ? [...new Set(stored.disabledSites.map(normalizeHostname).filter(Boolean))]
      : [];
    renderSites();
  } catch {
    setStatus(els.saveResult, "Could not load settings. Reload this page.", "err");
    els.save.disabled = true;
  }
}

els.toggleKey.addEventListener("click", () => {
  const showing = els.apiKey.type === "text";
  els.apiKey.type = showing ? "password" : "text";
  els.toggleKey.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
});

els.addSite.addEventListener("click", () => {
  const hostname = normalizeHostname(els.newSite.value);
  if (!hostname) {
    els.newSite.setAttribute("aria-invalid", "true");
    els.newSite.focus();
    return;
  }
  els.newSite.removeAttribute("aria-invalid");
  if (!disabledSites.includes(hostname)) {
    disabledSites.push(hostname);
    disabledSites.sort();
    renderSites();
  }
  els.newSite.value = "";
});

els.newSite.addEventListener("input", () => els.newSite.removeAttribute("aria-invalid"));
els.newSite.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.addSite.click();
  }
});

async function persist() {
  const model = getModel();
  await chrome.storage.local.set({
    groqApiKey: els.apiKey.value.trim(),
    model,
    language: els.language.value,
    liveCheckEnabled: els.liveCheck.checked,
    disabledSites,
  });
}

function friendlyError(error, retryAfterMs = null) {
  switch (error) {
    case "NO_API_KEY": return "Enter a Groq API key first.";
    case "GROQ_AUTH_ERROR": return "Groq could not authenticate this key. Check the key and try again.";
    case "GROQ_RATE_LIMIT": {
      if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        const seconds = Math.ceil(retryAfterMs / 1000);
        return `Groq rate-limited this request. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
      }
      return "Groq rate-limited this request. Check your usage limits and try again after they reset.";
    }
    case "GROQ_UNAVAILABLE": return "Groq is temporarily unavailable. Try again shortly.";
    case "REQUEST_TIMEOUT": return "The request timed out. Try again.";
    case "NETWORK_ERROR": return "Could not reach Groq. Check your connection.";
    case "NO_MODEL": return "Enter a Groq model ID.";
    default: return "Connection failed. Check the API key, model ID, and API access.";
  }
}

els.testKey.addEventListener("click", async () => {
  els.testKey.disabled = true;
  setStatus(els.testResult, "Testing connection...");
  try {
    await persist();
    const response = await chrome.runtime.sendMessage({ type: "GEMBAR_TEST_KEY" });
    if (response?.ok) setStatus(els.testResult, "Connection works", "ok");
    else setStatus(els.testResult, friendlyError(response?.error, response?.retryAfterMs), "err");
  } catch (error) {
    setStatus(els.testResult, error?.message || "Connection failed.", "err");
  } finally {
    els.testKey.disabled = false;
  }
});

els.save.addEventListener("click", async () => {
  els.save.disabled = true;
  try {
    await persist();
    setStatus(els.saveResult, "Saved", "ok");
  } catch (error) {
    setStatus(els.saveResult, error?.message || "Could not save settings.", "err");
  } finally {
    els.save.disabled = false;
    setTimeout(() => setStatus(els.saveResult, ""), 2500);
  }
});

load();
