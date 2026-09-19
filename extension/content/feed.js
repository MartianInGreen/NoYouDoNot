(() => {
  "use strict";

  const hostname = location.hostname.replace(/^www\./, "");
  const platform = hostname.endsWith("youtube.com") ? "youtube" : "twitter";
  const selectors =
    platform === "youtube"
      ? [
          "ytd-rich-item-renderer",
          "ytd-video-renderer",
          "ytd-compact-video-renderer",
          "ytd-grid-video-renderer",
          "ytd-playlist-video-renderer",
          "ytd-reel-item-renderer",
          "yt-lockup-view-model",
          "ytm-shorts-lockup-view-model-v2"
        ]
      : ['article[data-testid="tweet"]'];

  const signatures = new WeakMap();
  const elementsById = new Map();
  const itemById = new Map();
  const pending = new Map();
  const retryTimers = new Map();
  const twitterLocks = new WeakMap();
  let flushTimer;
  let scanTimer;

  const intersection = new IntersectionObserver(onIntersection, {
    rootMargin: "900px 0px",
    threshold: 0.01
  });

  const mutations = new MutationObserver(scheduleScan);
  mutations.observe(document.documentElement, { childList: true, subtree: true });
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === "SETTINGS_CHANGED") resetAll();
  });

  // YouTube recycles card elements without always adding a new root node.
  // The observer handles normal infinite scrolling; this catches recycled cards.
  setInterval(scan, 3000);
  scan();

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 180);
  }

  function scan() {
    const nodes = document.querySelectorAll(selectors.join(","));
    for (const element of nodes) {
      const item = extractItem(element);
      if (!item) continue;
      const signature = hash(`${item.url}|${item.author}|${item.title}|${item.text}`);
      if (signatures.get(element) === signature) continue;
      signatures.set(element, signature);
      clearElementState(element);
      item.id = `${platform}-${signature}`;
      itemById.set(item.id, item);
      if (!elementsById.has(item.id)) elementsById.set(item.id, new Set());
      elementsById.get(item.id).add(element);
      element.dataset.nydnId = item.id;
      intersection.unobserve(element);
      intersection.observe(element);
    }
  }

  function onIntersection(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target;
      const id = element.dataset.nydnId;
      if (!id || element.dataset.nydnClassified === "true") continue;
      const item = itemById.get(id);
      if (!item) continue;
      element.dataset.nydnPending = "true";
      pending.set(id, item);
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 350);
  }

  async function flush() {
    const items = [...pending.values()].slice(0, 8);
    if (!items.length) return;
    items.forEach((item) => pending.delete(item.id));
    try {
      const response = await browser.runtime.sendMessage({
        type: "CLASSIFY_FEED_ITEMS",
        platform,
        items
      });
      if (!response?.ok) throw new Error(response?.error || "Classification failed.");
      if (response.disabled) {
        items.forEach((item) => markSkipped(item.id));
      } else {
        const returned = new Set();
        for (const result of response.results || []) {
          returned.add(result.id);
          applyResult(result);
        }
        for (const item of items) {
          if (!returned.has(item.id)) queueRetry(item.id);
        }
      }
    } catch (error) {
      console.debug("[NYDN] feed classification unavailable", error);
      items.forEach((item) => queueRetry(item.id));
    }
    if (pending.size) scheduleFlush();
  }

  function applyResult(result) {
    if (result.unavailable) {
      queueRetry(result.id);
      return;
    }

    const elements = elementsById.get(result.id) || [];
    const item = itemById.get(result.id);
    for (const element of elements) {
      if (!element.isConnected || element.dataset.nydnId !== result.id) continue;
      element.dataset.nydnPending = "false";
      element.dataset.nydnClassified = "true";
      element.dataset.nydnAction = result.action || "allow";
      element.classList.remove(
        "nydn-limited",
        "nydn-promoted",
        "nydn-reviewing",
        "nydn-display-blur",
        "nydn-display-hide"
      );
      unlockTwitterCard(element);
      element.querySelector(":scope > .nydn-verdict")?.remove();

      if (result.action === "limit" && result.display === "badge") {
        element.append(buildBadge(result, item, element, "Would limit"));
      } else if (result.action === "limit") {
        lockTwitterCard(element);
        element.classList.add("nydn-limited", `nydn-display-${result.display || "blur"}`);
        const card = buildLimitCard(result, item, element);
        element.append(card);
      } else if (result.action === "promote") {
        element.classList.add("nydn-promoted");
        element.append(buildBadge(result, item, element, "Worth your attention"));
      } else if (result.display === "badge") {
        element.append(buildBadge(result, item, element, "Checked"));
      }
    }
  }

  function buildLimitCard(result, item, element) {
    const card = document.createElement("div");
    card.className = "nydn-verdict nydn-limit-card";
    card.setAttribute("role", "note");

    const eyebrow = document.createElement("span");
    eyebrow.className = "nydn-eyebrow";
    eyebrow.textContent = "YOUR ALGORITHM";
    const heading = document.createElement("strong");
    heading.textContent = result.display === "hide"
      ? "Hidden from your feed"
      : "Soft-limited in your feed";
    const detail = document.createElement("span");
    detail.className = "nydn-detail";
    detail.textContent = resultSummary(result);
    const actions = document.createElement("div");
    actions.className = "nydn-actions";

    const review = button("Review item", "primary");
    review.addEventListener("click", (event) => {
      stop(event);
      beginReview(element, card, result, item);
    });
    actions.append(review);
    card.append(eyebrow, heading, detail, actions);
    card.addEventListener("click", stop);
    isolateTwitterHover(card);
    return card;
  }

  function lockTwitterCard(element) {
    if (platform !== "twitter" || twitterLocks.has(element)) return;
    const height = element.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0) return;

    const cell = element.closest('[data-testid="cellInnerDiv"]');
    const cellHeight = cell?.getBoundingClientRect().height || 0;
    twitterLocks.set(element, { cell });

    element.style.setProperty("--nydn-locked-height", `${height}px`);
    element.classList.add("nydn-twitter-locked");
    if (cell && Number.isFinite(cellHeight) && cellHeight > 0) {
      cell.style.setProperty("--nydn-locked-cell-height", `${cellHeight}px`);
      cell.classList.add("nydn-twitter-cell-locked");
    }
  }

  function unlockTwitterCard(element) {
    const lock = twitterLocks.get(element);
    twitterLocks.delete(element);
    element.classList.remove("nydn-twitter-locked");
    element.style.removeProperty("--nydn-locked-height");
    if (lock?.cell) {
      lock.cell.classList.remove("nydn-twitter-cell-locked");
      lock.cell.style.removeProperty("--nydn-locked-cell-height");
    }
  }

  function isolateTwitterHover(node) {
    if (platform !== "twitter") return;
    for (const type of ["pointerover", "pointerout", "mouseover", "mouseout", "mousemove"]) {
      node.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  function beginReview(element, card, result, item) {
    element.classList.remove("nydn-limited", "nydn-display-blur", "nydn-display-hide");
    element.classList.add("nydn-reviewing");
    card.className = "nydn-verdict nydn-review-bar";

    const eyebrow = document.createElement("span");
    eyebrow.className = "nydn-eyebrow";
    eyebrow.textContent = "REVIEW MODE";
    const heading = document.createElement("strong");
    heading.textContent = "Does this belong in your feed?";
    const detail = document.createElement("span");
    detail.className = "nydn-detail";
    const itemPreview = clean(item?.title || item?.text, 180);
    detail.textContent = itemPreview
      ? `“${itemPreview}” · Nothing is recorded until you choose.`
      : "Nothing is recorded until you choose.";
    const actions = document.createElement("div");
    actions.className = "nydn-actions";

    const keep = button("Keep filtered", "quiet");
    keep.addEventListener("click", (event) => {
      stop(event);
      sendFeedback(item, result, "limit");
      element.classList.remove("nydn-reviewing");
      element.classList.add("nydn-limited", `nydn-display-${result.display || "blur"}`);
      const replacement = buildLimitCard(result, item, element);
      card.replaceWith(replacement);
    });

    const showOnce = button("Show once", "quiet");
    showOnce.addEventListener("click", (event) => {
      stop(event);
      element.classList.remove("nydn-reviewing");
      unlockTwitterCard(element);
      element.dataset.nydnAction = "show-once";
      card.remove();
    });

    const correct = button("Should be shown", "primary");
    correct.addEventListener("click", (event) => {
      stop(event);
      element.classList.remove("nydn-reviewing");
      unlockTwitterCard(element);
      element.dataset.nydnAction = "feedback-show";
      card.remove();
      sendFeedback(item, result, "show");
    });

    actions.append(keep, showOnce, correct);
    card.replaceChildren(eyebrow, heading, detail, actions);
  }

  function buildBadge(result, item, element, label) {
    const badge = document.createElement("div");
    badge.className = "nydn-verdict nydn-badge";
    const text = document.createElement("span");
    text.textContent = `◆ ${label}`;
    text.title = resultSummary(result);
    const less = button("Less like this", "link");
    less.addEventListener("click", (event) => {
      stop(event);
      less.textContent = "Noted ✓";
      less.disabled = true;
      sendFeedback(item, result, "limit");
      if (result.action !== "promote") element.dataset.nydnAction = "feedback-limit";
    });
    badge.append(text, less);
    badge.addEventListener("click", stop);
    return badge;
  }

  function button(text, style) {
    const value = document.createElement("button");
    value.type = "button";
    value.className = `nydn-button nydn-${style}`;
    value.textContent = text;
    return value;
  }

  function resultSummary(result) {
    const informative = Number(result.informative?.score);
    const topic = Number(result.topicFit);
    const confidence = Number(result.disposition?.confidence);
    const parts = [];
    if (Number.isFinite(informative)) parts.push(`information ${informative.toFixed(1)}/3`);
    if (Number.isFinite(topic)) parts.push(`topic match ${Math.round(topic * 100)}%`);
    if (Number.isFinite(confidence)) parts.push(`confidence ${Math.round(confidence * 100)}%`);
    return parts.join(" · ") || "Classified against your feed intent";
  }

  async function sendFeedback(item, result, userLabel) {
    if (!item) return;
    try {
      await browser.runtime.sendMessage({
        type: "FEED_FEEDBACK",
        platform,
        item,
        userLabel,
        classifierChoice: result.disposition?.choice || ""
      });
    } catch (error) {
      console.debug("[NYDN] could not save feed feedback", error);
    }
  }

  function markSkipped(id) {
    for (const element of elementsById.get(id) || []) {
      element.dataset.nydnPending = "false";
      element.dataset.nydnClassified = "true";
      element.dataset.nydnAction = "allow";
    }
  }

  function queueRetry(id, delay = 30000) {
    for (const element of elementsById.get(id) || []) {
      element.dataset.nydnPending = "false";
      delete element.dataset.nydnClassified;
      delete element.dataset.nydnAction;
    }
    if (retryTimers.has(id)) return;
    retryTimers.set(
      id,
      setTimeout(() => {
        retryTimers.delete(id);
        const item = itemById.get(id);
        const elements = [...(elementsById.get(id) || [])].filter(
          (element) => element.isConnected && element.dataset.nydnId === id
        );
        if (!item || !elements.length) return;
        elements.forEach((element) => {
          element.dataset.nydnPending = "true";
        });
        pending.set(id, item);
        scheduleFlush();
      }, delay)
    );
  }

  function resetAll() {
    pending.clear();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    itemById.clear();
    elementsById.clear();
    document.querySelectorAll("[data-nydn-id]").forEach((element) => {
      intersection.unobserve(element);
      signatures.delete(element);
      clearElementState(element);
      delete element.dataset.nydnId;
    });
    setTimeout(scan, 100);
  }

  function clearElementState(element) {
    element.classList.remove(
      "nydn-limited",
      "nydn-promoted",
      "nydn-reviewing",
      "nydn-display-blur",
      "nydn-display-hide"
    );
    unlockTwitterCard(element);
    element.querySelector(":scope > .nydn-verdict")?.remove();
    delete element.dataset.nydnPending;
    delete element.dataset.nydnClassified;
    delete element.dataset.nydnAction;
  }

  function extractItem(element) {
    if (platform === "youtube") return extractYouTube(element);
    return extractTwitter(element);
  }

  function extractYouTube(element) {
    const titleNode = element.querySelector(
      [
        "#video-title",
        "a#video-title-link",
        "a.yt-lockup-metadata-view-model__title",
        "a.ytLockupMetadataViewModelTitle",
        ".yt-lockup-metadata-view-model-wiz__title a[href]",
        ".shortsLockupViewModelHostMetadataTitle a[href]"
      ].join(",")
    );
    const heading = titleNode?.closest("h3");
    const title = clean(
      titleNode?.getAttribute("title") ||
        titleNode?.getAttribute("aria-label") ||
        heading?.getAttribute("title") ||
        heading?.getAttribute("aria-label") ||
        titleNode?.textContent,
      500
    );
    if (!title) return null;
    const link =
      titleNode?.closest("a[href]") ||
      titleNode?.querySelector?.("a[href]") ||
      element.querySelector('a[href*="/watch"], a[href^="/shorts/"]');
    const channel = element.querySelector(
      [
        "#channel-name",
        "ytd-channel-name",
        ".yt-content-metadata-view-model-wiz__metadata-row",
        ".ytContentMetadataViewModelMetadataRow a[href^='/@']"
      ].join(",")
    );
    const metadata = element.querySelector(
      [
        "#metadata-line",
        ".ytd-video-meta-block",
        ".yt-content-metadata-view-model-wiz__metadata-text",
        ".ytContentMetadataViewModelMetadataRow",
        ".shortsLockupViewModelHostMetadataSubhead"
      ].join(",")
    );
    return {
      id: "",
      title,
      text: "",
      author: clean(channel?.textContent, 180),
      metadata: clean(metadata?.textContent, 300),
      url: absoluteUrl(link?.getAttribute("href"))
    };
  }

  function extractTwitter(element) {
    const textNode = element.querySelector('[data-testid="tweetText"]');
    const text = clean(textNode?.textContent, 1400);
    if (!text) return null;
    const user = element.querySelector('[data-testid="User-Name"]');
    const statusLink = [...element.querySelectorAll('a[href*="/status/"]')].find((link) =>
      /\/status\/\d+/.test(link.getAttribute("href") || "")
    );
    return {
      id: "",
      title: "",
      text,
      author: clean(user?.textContent, 180),
      metadata: "",
      url: absoluteUrl(statusLink?.getAttribute("href"))
    };
  }

  function absoluteUrl(value) {
    try {
      return new URL(value || "", location.origin).href;
    } catch {
      return "";
    }
  }

  function clean(value, maximum) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      value ^= text.charCodeAt(index);
      value = Math.imul(value, 16777619);
    }
    return (value >>> 0).toString(36);
  }

  function stop(event) {
    event.preventDefault();
    event.stopPropagation();
  }
})();
