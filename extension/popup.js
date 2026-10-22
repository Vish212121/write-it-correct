(async function () {
  const toggle = document.getElementById("siteToggle");
  const site = document.getElementById("site");
  const warning = document.getElementById("noKeyWarn");
  const openOptions = document.getElementById("openOptions");

  openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let hostname = "";
    try {
      const url = tab?.url ? new URL(tab.url) : null;
      if (["http:", "https:"].includes(url?.protocol)) hostname = url.hostname.toLowerCase();
    } catch {}

    site.textContent = hostname || "This page does not allow extensions";
    const stored = await chrome.storage.local.get({ disabledSites: [], groqApiKey: "" });
    const disabledSites = Array.isArray(stored.disabledSites) ? stored.disabledSites : [];
    warning.hidden = Boolean(stored.groqApiKey);
    toggle.checked = Boolean(hostname) && !disabledSites.includes(hostname);
    toggle.disabled = !hostname;

    toggle.addEventListener("change", async () => {
      toggle.disabled = true;
      try {
        const latest = await chrome.storage.local.get({ disabledSites: [] });
        const current = Array.isArray(latest.disabledSites) ? latest.disabledSites : [];
        const next = toggle.checked
          ? current.filter((entry) => entry !== hostname)
          : [...new Set([...current, hostname])];
        await chrome.storage.local.set({ disabledSites: next });
      } catch {
        toggle.checked = !toggle.checked;
      } finally {
        toggle.disabled = false;
      }
    });
  } catch {
    site.textContent = "Could not load this site";
    toggle.disabled = true;
  }
})();
