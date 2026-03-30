"use strict";

const fs = require("fs");
const vm = require("vm");
const { chromium } = require("playwright-core");
const cdpNetwork = require("./cdp-network");
const { ProfileOwnership } = require("./profile-ownership");
const { RuntimeRecoveryError } = require("./runtime-errors");
const { isRuntimeHealthy, shouldRecoverFromError } = require("./runtime-health");

class BrowserRuntime {
  constructor(options) {
    this.options = {
      headless: true,
      executablePath: "",
      userDataDir: "",
      workingDir: process.cwd(),
      runtimeVersion: "0.1.0",
      browserEngine: chromium,
      ...options,
    };
    this.started = false;
    this.closed = false;
    this.contextClosed = false;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleEntries = [];
    this.consoleNavigationIndex = 0;
    this.pendingDialog = null;
    this.pendingFileChooser = null;
    this.pageBindings = new WeakSet();
    this.cdpStore = cdpNetwork.createNetworkStore();
    this.cdpSessions = new Map();
    this.cdpAttachPromises = new Map();
    this.cdpSessionSeq = 0;
    this.networkNavigationIndex = 0;
    this.recordingFromIndex = 0;
    this.startPromise = null;
    this.recoveryPromise = null;
    this.heartbeatTimer = null;
    this.ownershipClaimed = false;
    this.ownership = new ProfileOwnership({
      userDataDir: this.options.userDataDir,
      runtimeVersion: this.options.runtimeVersion,
    });
  }

  async start() {
    await this.ensureStarted();
  }

  async ensureStarted() {
    if (this.startPromise) {
      return this.startPromise;
    }
    if (this.started && isRuntimeHealthy(this)) {
      return;
    }
    this.startPromise = this.initializeRuntime();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async claimOwnership() {
    if (this.closed) {
      throw new Error("browser session is closed");
    }
    if (this.ownershipClaimed || !this.options.userDataDir) {
      return;
    }
    const prepared = await this.ownership.prepareForLaunch();
    if (prepared.mode !== "ephemeral") {
      await this.ownership.writeOwnership();
      this.startHeartbeat();
      this.ownershipClaimed = true;
    }
  }

  async navigate(url) {
    return this.withPageAction(async (page) => {
      const normalized = normalizeURL(url);
      this.consoleNavigationIndex = this.consoleEntries.length;
      this.networkNavigationIndex = this.networkOrder().length;
      await page.goto(normalized, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      return {
        code: [`await page.goto(${JSON.stringify(normalized)});`],
        message: `Navigated to ${normalized}`,
      };
    });
  }

  async navigateBack() {
    return this.withPageAction(async (page) => {
      await page.goBack({ timeout: 30000 });
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      return {
        code: ["await page.goBack();"],
        message: "Navigated back.",
      };
    });
  }

  async snapshot(request = {}) {
    return this.withPageAction((page) => buildSnapshot(page, request.selector || ""));
  }

  async getPageState() {
    return this.withPageAction((page) => getPageState(page));
  }

  async click(params) {
    return this.withPageAction(async (page) => {
      const { locator, resolved } = this.locatorFor(page, params);
      const options = {};
      if (params.button) options.button = params.button;
      if (params.modifiers) options.modifiers = params.modifiers;

      if (params.doubleClick) {
        const result = await this.performPointerAction(page, () => locator.dblclick(options));
        return {
          code: [`await page.${resolved}.dblclick(${JSON.stringify(options)});`],
          message: "Double click completed.",
          ...result,
        };
      }

      const result = await this.performPointerAction(page, () => locator.click(options));
      return {
        code: [`await page.${resolved}.click(${JSON.stringify(options)});`],
        message: "Click completed.",
        ...result,
      };
    });
  }

  async type(params) {
    return this.withPageAction(async (page) => {
      const { locator, resolved } = this.locatorFor(page, params);
      if (params.slowly) {
        await waitForCompletion(page, async () => {
          await locator.click();
          await locator.pressSequentially(params.text);
          if (params.submit) {
            await locator.press("Enter");
          }
        });
        return {
          code: [`await page.${resolved}.pressSequentially(${JSON.stringify(params.text)});`],
          message: "Typing completed.",
        };
      }

      await waitForCompletion(page, async () => {
        await locator.fill(params.text);
        if (params.submit) {
          await locator.press("Enter");
        }
      });
      return {
        code: [`await page.${resolved}.fill(${JSON.stringify(params.text)});`],
        message: "Typing completed.",
      };
    });
  }

  async hover(params) {
    return this.withPageAction(async (page) => {
      const { locator, resolved } = this.locatorFor(page, params);
      await waitForCompletion(page, () => locator.hover());
      return {
        code: [`await page.${resolved}.hover();`],
        message: "Hover completed.",
      };
    });
  }

  async drag(params) {
    return this.withPageAction(async (page) => {
      const start = this.locatorFor(page, { ref: params.startRef, selector: params.startSelector });
      const end = this.locatorFor(page, { ref: params.endRef, selector: params.endSelector });
      await waitForCompletion(page, () => start.locator.dragTo(end.locator));
      return {
        code: [`await page.${start.resolved}.dragTo(page.${end.resolved});`],
        message: "Drag completed.",
      };
    });
  }

  async selectOption(params) {
    return this.withPageAction(async (page) => {
      const { locator, resolved } = this.locatorFor(page, params);
      await waitForCompletion(page, () => locator.selectOption(params.values));
      return {
        code: [`await page.${resolved}.selectOption(${JSON.stringify(params.values)});`],
        message: "Select option completed.",
      };
    });
  }

  async pressKey(params) {
    return this.withPageAction(async (page) => {
      await waitForCompletion(page, () => page.keyboard.press(params.key));
      return {
        code: [`await page.keyboard.press(${JSON.stringify(params.key)});`],
        message: `Pressed key ${params.key}.`,
      };
    });
  }

  async waitFor(params) {
    return this.withPageAction(async (page) => {
      if (params.time) {
        await page.waitForTimeout(Math.min(30000, Number(params.time) * 1000));
      }
      if (params.text) {
        await page.getByText(params.text).first().waitFor({ state: "visible", timeout: 30000 });
      }
      if (params.textGone) {
        await page.getByText(params.textGone).first().waitFor({ state: "hidden", timeout: 30000 });
      }
      return {
        code: ["// wait completed"],
        message: `Waited for ${params.text || params.textGone || params.time}`,
      };
    });
  }

  async resize(params) {
    return this.withPageAction(async (page) => {
      await page.setViewportSize({ width: params.width, height: params.height });
      return {
        code: [`await page.setViewportSize({ width: ${params.width}, height: ${params.height} });`],
        message: `Viewport resized to ${params.width}x${params.height}.`,
      };
    });
  }

  async evaluate(params) {
    return this.withPageAction(async (page) => {
      const fnText = params.function.includes("=>") ? params.function : `() => (${params.function})`;
      const fn = vm.runInNewContext(`(${fnText})`);
      let result;
      if (params.ref || params.selector) {
        const { locator, resolved } = this.locatorFor(page, params);
        result = await locator.evaluate(fn);
        return {
          code: [`await page.${resolved}.evaluate(${JSON.stringify(fnText)});`],
          output: stringifyResult(result),
        };
      }
      result = await page.evaluate(fn);
      return {
        code: [`await page.evaluate(${JSON.stringify(fnText)});`],
        output: stringifyResult(result),
      };
    });
  }

  async runCode(params) {
    return this.withPageAction(async (page) => {
      const fn = vm.runInNewContext(`(${params.code})`);
      const result = await fn(page);
      return {
        code: [`await (${params.code})(page);`],
        output: stringifyResult(result),
      };
    });
  }

  async takeScreenshot(params = {}) {
    return this.withPageAction(async (page) => {
      const type = params.type || "png";
      let data;
      let code;
      if (params.ref || params.selector) {
        const { locator, resolved } = this.locatorFor(page, params);
        data = await locator.screenshot({ type });
        code = [`await page.${resolved}.screenshot({ type: ${JSON.stringify(type)} });`];
      } else {
        data = await page.screenshot({ type, fullPage: !!params.fullPage });
        code = [`await page.screenshot({ type: ${JSON.stringify(type)}, fullPage: ${!!params.fullPage} });`];
      }
      return {
        code,
        mimeType: type === "jpeg" ? "image/jpeg" : "image/png",
        dataBase64: Buffer.from(data).toString("base64"),
      };
    });
  }

  async networkRequests(params = {}) {
    await this.ensureRuntimeForAction();
    return this.withRuntimeRecovery(async () => {
      const entries = this.networkOrder()
        .slice(params.includeAll ? 0 : this.networkNavigationIndex)
        .map((id) => this.networkRecords().get(id))
        .filter(Boolean);
      return {
        title: "Network",
        content: renderNetwork(entries, !!params.includeStatic),
      };
    });
  }

  async consoleMessages(params = {}) {
    await this.ensureRuntimeForAction();
    return this.withRuntimeRecovery(async () => {
      const minLevel = consoleThreshold(params.level || "info");
      const entries = (params.all ? this.consoleEntries : this.consoleEntries.slice(this.consoleNavigationIndex))
        .filter((entry) => consoleLevel(entry.type) <= minLevel);
      return {
        title: "Console",
        content: renderConsole(entries),
      };
    });
  }

  async handleDialog(params) {
    return this.withPageAction(async (page) => {
      if (!this.pendingDialog) {
        throw new Error("No dialog visible");
      }
      const dialog = this.pendingDialog;
      this.pendingDialog = null;
      await waitForCompletion(page, () => (params.accept ? dialog.accept(params.promptText) : dialog.dismiss()));
      return {
        code: [params.accept ? "await dialog.accept();" : "await dialog.dismiss();"],
        message: params.accept ? "Dialog accepted." : "Dialog dismissed.",
      };
    });
  }

  async fileUpload(params = {}) {
    return this.withPageAction(async (page) => {
      if (!this.pendingFileChooser) {
        throw new Error("No file chooser visible");
      }
      const chooser = this.pendingFileChooser;
      this.pendingFileChooser = null;
      await waitForCompletion(page, async () => {
        if (params.paths && params.paths.length) {
          await chooser.setFiles(params.paths);
        } else {
          await chooser.setFiles([]);
        }
      });
      return {
        code: [`await fileChooser.setFiles(${JSON.stringify(params.paths || [])});`],
        message: "File upload completed.",
      };
    });
  }

  async fillForm(params = {}) {
    return this.withPageAction(async (page) => {
      for (const field of params.fields || []) {
        const { locator } = this.locatorFor(page, { ref: field.ref, selector: field.selector });
        if (field.type === "textbox" || field.type === "slider") {
          await locator.fill(field.value);
        } else if (field.type === "checkbox" || field.type === "radio") {
          await locator.setChecked(field.value === "true");
        } else if (field.type === "combobox") {
          await locator.selectOption({ label: field.value });
        }
      }
      await page.waitForTimeout(200);
      return {
        code: ["// form fields filled"],
        message: "Form filled.",
      };
    });
  }

  async browserTabs(params = {}) {
    await this.ensureRuntimeForAction({ allowNoPage: true });
    return this.withRuntimeRecovery(async () => {
      const action = String(params.action || "").trim().toLowerCase();
      switch (action) {
        case "list": {
          const page = this.currentPageOrNull();
          return {
            message: `Listed ${this.openPages().length} tabs.`,
            tabs: await listTabs(this),
            page: await getOptionalPageState(page),
          };
        }
        case "create": {
          const page = await this.context.newPage();
          this.setActivePage(page);
          await page.bringToFront().catch(() => {});
          return {
            code: ["const page = await context.newPage();"],
            message: "Created a new tab.",
            tabs: await listTabs(this),
            page: await getOptionalPageState(page),
          };
        }
        case "select": {
          const index = parseTabIndex(params.index, "select");
          const pages = this.openPages();
          if (index < 0 || index >= pages.length) {
            throw new Error(`browser_tabs: tab index ${index} out of range`);
          }
          const page = pages[index];
          this.setActivePage(page);
          await page.bringToFront().catch(() => {});
          return {
            code: [`// switched to tab ${index}`],
            message: `Selected tab ${index}.`,
            tabs: await listTabs(this),
            page: await getOptionalPageState(page),
          };
        }
        case "close": {
          const pages = this.openPages();
          if (!pages.length) {
            throw new Error("no active tab, use browser_tabs with action=create or select first");
          }
          const index = typeof params.index === "number"
            ? parseTabIndex(params.index, "close")
            : pages.indexOf(this.currentPage());
          if (index < 0 || index >= pages.length) {
            throw new Error(`browser_tabs: tab index ${index} out of range`);
          }
          const page = pages[index];
          await page.close();
          const remainingPages = this.openPages();
          if (remainingPages.length) {
            const nextIndex = Math.min(index, remainingPages.length - 1);
            this.setActivePage(remainingPages[nextIndex]);
            await remainingPages[nextIndex].bringToFront().catch(() => {});
          } else {
            this.page = null;
          }
          return {
            code: [typeof params.index === "number" ? `// closed tab ${index}` : "await page.close();"],
            message: `Closed tab ${index}.`,
            tabs: await listTabs(this),
            page: await getOptionalPageState(this.currentPageOrNull()),
          };
        }
        default:
          throw new Error(`browser_tabs: unsupported action "${action}"`);
      }
    });
  }

  async startNetworkCapture() {
    await this.ensureRuntimeForAction();
    return this.withRuntimeRecovery(async () => {
      await this.ensureAllCDPSessions();
      this.recordingFromIndex = this.networkOrder().length;
    });
  }

  async stopNetworkCapture() {
    await this.ensureRuntimeForAction();
    return this.withRuntimeRecovery(async () => {
      await settleRecordingCapture(this);
      return recordingSlice(this);
    });
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopHeartbeat();
    await this.destroyRuntime();
    await this.ownership.removeOwnership().catch(() => {});
    this.ownershipClaimed = false;
  }

  networkOrder() {
    return this.cdpStore.order;
  }

  networkRecords() {
    return this.cdpStore.records;
  }

  openPages() {
    if (!this.context) {
      return [];
    }
    return this.context.pages().filter((page) => !page.isClosed());
  }

  firstOpenPage() {
    return this.openPages()[0] || null;
  }

  currentPageOrNull() {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    this.page = this.firstOpenPage();
    return this.page;
  }

  currentPage() {
    const page = this.currentPageOrNull();
    if (!page) {
      throw new Error("no active tab, use browser_tabs with action=create or select first");
    }
    this.attachPageListeners(page);
    return page;
  }

  setActivePage(page) {
    if (!page || page.isClosed()) {
      this.page = this.firstOpenPage();
      return this.page;
    }
    this.attachPageListeners(page);
    this.page = page;
    return page;
  }

  attachPageListeners(page) {
    if (!page || page.isClosed() || this.pageBindings.has(page)) {
      return;
    }
    this.pageBindings.add(page);

    page.on("console", async (msg) => {
      let text = msg.text();
      try {
        const args = await Promise.all(msg.args().map((arg) => arg.jsonValue().catch(() => undefined)));
        if (args.length && args.some((item) => typeof item !== "undefined")) {
          text = args.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ");
        }
      } catch (_) {}
      this.consoleEntries.push({
        type: msg.type(),
        text,
        location: msg.location(),
      });
    });

    page.on("dialog", (dialog) => {
      this.pendingDialog = dialog;
    });

    page.on("filechooser", (fileChooser) => {
      this.pendingFileChooser = fileChooser;
    });

    page.on("close", () => {
      if (this.page === page) {
        this.page = this.firstOpenPage();
      }
      this.cdpSessions.delete(page);
      this.cdpAttachPromises.delete(page);
    });
  }

  locatorFor(page, target) {
    if (target.ref) {
      return {
        locator: page.locator(`[data-spotter-ref="${escapeForSelector(target.ref)}"]`).first(),
        resolved: `locator('[data-spotter-ref="${escapeForSelector(target.ref)}"]')`,
      };
    }
    if (target.selector) {
      return {
        locator: page.locator(target.selector).first(),
        resolved: `locator(${JSON.stringify(target.selector)})`,
      };
    }
    throw new Error("ref or selector is required");
  }

  async ensureCDPSession(page) {
    if (!page || page.isClosed()) {
      return null;
    }
    if (this.cdpSessions.has(page)) {
      return this.cdpSessions.get(page);
    }
    if (this.cdpAttachPromises.has(page)) {
      return this.cdpAttachPromises.get(page);
    }

    const attachPromise = (async () => {
      const client = await this.context.newCDPSession(page);
      const tracker = cdpNetwork.createSessionTracker(`cdp-${++this.cdpSessionSeq}`);

      client.on("Network.requestWillBeSent", async (event) => {
        cdpNetwork.recordRequestWillBeSent(this.cdpStore, tracker, event);
        if (event.request && event.request.hasPostData && typeof event.request.postData !== "string") {
          try {
            const result = await client.send("Network.getRequestPostData", { requestId: event.requestId });
            cdpNetwork.applyRequestPostData(this.cdpStore, tracker, event.requestId, result.postData);
          } catch (_) {}
        }
      });
      client.on("Network.requestWillBeSentExtraInfo", (event) => {
        cdpNetwork.recordRequestWillBeSentExtraInfo(this.cdpStore, tracker, event);
      });
      client.on("Network.responseReceived", (event) => {
        cdpNetwork.recordResponseReceived(this.cdpStore, tracker, event);
      });
      client.on("Network.responseReceivedExtraInfo", (event) => {
        cdpNetwork.recordResponseReceivedExtraInfo(this.cdpStore, tracker, event);
      });
      client.on("Network.loadingFinished", async (event) => {
        cdpNetwork.recordLoadingFinished(this.cdpStore, tracker, event);
        try {
          const result = await client.send("Network.getResponseBody", { requestId: event.requestId });
          cdpNetwork.applyResponseBody(this.cdpStore, tracker, event.requestId, result.body, !!result.base64Encoded);
        } catch (_) {}
      });
      client.on("Network.loadingFailed", (event) => {
        cdpNetwork.recordLoadingFailed(this.cdpStore, tracker, event);
      });

      await client.send("Network.enable");
      const sessionInfo = { client, tracker };
      this.cdpSessions.set(page, sessionInfo);
      return sessionInfo;
    })();

    this.cdpAttachPromises.set(page, attachPromise);
    try {
      return await attachPromise;
    } finally {
      this.cdpAttachPromises.delete(page);
    }
  }

  async ensureAllCDPSessions() {
    await Promise.all(this.openPages().map((page) => this.ensureCDPSession(page)));
  }

  async performPointerAction(page, action) {
    const beforePages = new Set(this.openPages());
    const popupPromise = page.waitForEvent ? page.waitForEvent("popup", { timeout: 1500 }).catch(() => null) : Promise.resolve(null);
    const contextPagePromise = this.context.waitForEvent ? this.context.waitForEvent("page", { timeout: 1500 }).catch(() => null) : Promise.resolve(null);

    await waitForCompletion(page, action);

    const popupPage = await popupPromise;
    const contextPage = await contextPagePromise;
    const openedPage = await this.resolveOpenedPage(beforePages, popupPage, contextPage);
    if (!openedPage) {
      return {};
    }

    return {
      opened_new_tab: true,
      new_tab: await describeTab(this, openedPage),
    };
  }

  async resolveOpenedPage(beforePages, popupPage, contextPage) {
    const directCandidate = firstLivePage([popupPage, contextPage], beforePages);
    if (directCandidate) {
      await this.ensureCDPSession(directCandidate);
      return directCandidate;
    }

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const candidate = firstLivePage(this.openPages(), beforePages);
      if (candidate) {
        await this.ensureCDPSession(candidate);
        return candidate;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  async ensureRuntimeForAction(options = {}) {
    if (this.closed) {
      throw new Error("browser session is closed");
    }
    await this.ensureStarted();
    const page = options.allowNoPage ? this.currentPageOrNull() : this.currentPage();
    if (!options.allowNoPage && !page) {
      throw new Error("no active tab, use browser_tabs with action=create or select first");
    }
  }

  async initializeRuntime() {
    await this.claimOwnership();
    try {
      await this.launchBrowserContext();
      this.started = true;
      this.closed = false;
    } catch (error) {
      await this.ownership.removeOwnership().catch(() => {});
      this.stopHeartbeat();
      this.ownershipClaimed = false;
      throw error;
    }
  }

  async launchBrowserContext() {
    const resolvedExecutablePath = this.options.executablePath || defaultBrowserPath() || undefined;
    const launchOptions = {
      headless: this.options.headless,
      executablePath: resolvedExecutablePath,
    };
    const engine = this.options.browserEngine || chromium;

    this.contextClosed = false;
    this.resetRuntimeState();

    if (this.options.userDataDir) {
      this.context = await engine.launchPersistentContext(this.options.userDataDir, {
        ...launchOptions,
        viewport: { width: 1280, height: 900 },
      });
      this.browser = this.context.browser();
    } else {
      this.browser = await engine.launch(launchOptions);
      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
    }

    this.attachContextListeners();
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    this.page = this.context.pages()[0] || await this.context.newPage();
    for (const existingPage of this.context.pages()) {
      this.attachPageListeners(existingPage);
      await this.ensureCDPSession(existingPage);
    }
    this.setActivePage(this.page);
  }

  attachContextListeners() {
    if (!this.context) {
      return;
    }
    this.context.on("page", (newPage) => {
      this.attachPageListeners(newPage);
      void this.ensureCDPSession(newPage);
    });
    this.context.on("close", () => {
      this.contextClosed = true;
      this.page = null;
    });
    if (this.browser && typeof this.browser.on === "function") {
      this.browser.on("disconnected", () => {
        this.contextClosed = true;
      });
    }
  }

  async destroyRuntime() {
    this.contextClosed = true;
    const context = this.context;
    const browser = this.browser;
    this.resetRuntimeState();
    if (context) {
      await context.close().catch(() => {});
    }
    if (browser && browser.isConnected && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }

  resetRuntimeState() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.pendingDialog = null;
    this.pendingFileChooser = null;
    this.pageBindings = new WeakSet();
    this.cdpSessions = new Map();
    this.cdpAttachPromises = new Map();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    if (!this.options.userDataDir) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      void this.ownership.refreshOwnershipHeartbeat().catch(() => {});
    }, 5000);
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async recoverRuntime(error) {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    this.recoveryPromise = (async () => {
      await this.ownership.assertCurrentOwner();
      await this.destroyRuntime();
      try {
        await this.launchBrowserContext();
      } catch (launchError) {
        throw new RuntimeRecoveryError("failed to rebuild browser runtime", {
          user_data_dir: this.options.userDataDir || "",
          runtime_stage: "rebuild",
          cause: launchError.message,
          original_error: error && error.message ? error.message : String(error || ""),
        });
      }
    })();
    try {
      await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async withRuntimeRecovery(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!shouldRecoverFromError(error)) {
        throw error;
      }
      await this.recoverRuntime(error);
      return operation();
    }
  }

  async withPageAction(operation) {
    await this.ensureRuntimeForAction();
    return this.withRuntimeRecovery(async () => operation(this.currentPage()));
  }
}

function defaultBrowserPath() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function normalizeURL(input) {
  try {
    return new URL(input).toString();
  } catch (_) {
    if (String(input).startsWith("localhost")) {
      return `http://${input}`;
    }
    return `https://${input}`;
  }
}

function escapeForSelector(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stringifyResult(value) {
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

async function waitForCompletion(page, fn) {
  await fn();
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
}

async function buildSnapshot(page, selector) {
  const payload = await page.evaluate((rootSelector) => {
    const root = rootSelector ? document.querySelector(rootSelector) : (document.body || document.documentElement);
    if (!root) {
      throw new Error(rootSelector ? `selector not found: ${rootSelector}` : "document root not found");
    }

    let maxRef = 0;
    document.querySelectorAll("[data-spotter-ref]").forEach((el) => {
      const raw = el.getAttribute("data-spotter-ref") || "";
      const num = Number(raw.replace(/^e/, ""));
      if (!Number.isNaN(num)) {
        maxRef = Math.max(maxRef, num);
      }
    });

    const refs = [];

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function roleOf(el) {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (["checkbox", "radio"].includes(type)) return type;
        return "textbox";
      }
      if (el.isContentEditable) return "textbox";
      return tag;
    }

    function labelOf(el) {
      return (
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.innerText ||
        el.textContent ||
        el.getAttribute("name") ||
        el.getAttribute("id") ||
        ""
      ).replace(/\s+/g, " ").trim();
    }

    function valueOf(el) {
      if ("value" in el && typeof el.value === "string") {
        return el.value.trim();
      }
      return "";
    }

    function isInteresting(el) {
      const tag = el.tagName.toLowerCase();
      if (["input", "textarea", "button", "select", "option"].includes(tag)) return true;
      if (tag === "a" && el.getAttribute("href")) return true;
      if (el.getAttribute("role")) return true;
      if (el.isContentEditable) return true;
      return false;
    }

    const queue = [root];
    while (queue.length) {
      const el = queue.shift();
      if (!(el instanceof Element)) continue;
      for (const child of Array.from(el.children)) queue.push(child);
      if (!isInteresting(el) || !isVisible(el)) continue;

      let ref = el.getAttribute("data-spotter-ref");
      if (!ref) {
        maxRef += 1;
        ref = `e${maxRef}`;
        el.setAttribute("data-spotter-ref", ref);
      }

      refs.push({
        ref,
        role: roleOf(el),
        name: labelOf(el),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        value: valueOf(el),
      });
    }

    return {
      url: location.href,
      title: document.title,
      refs,
    };
  }, selector || null);

  const lines = [
    `URL: ${payload.url}`,
    `Title: ${payload.title || "(untitled)"}`,
    "",
    "Elements:",
  ];
  for (const ref of payload.refs) {
    const extras = [];
    if (ref.name) extras.push(`name="${ref.name}"`);
    if (ref.type) extras.push(`type="${ref.type}"`);
    if (ref.value) extras.push(`value="${ref.value}"`);
    lines.push(`- [${ref.ref}] <${ref.tag}> role=${ref.role}${extras.length ? ` ${extras.join(" ")}` : ""}`);
  }
  return {
    url: payload.url,
    title: payload.title,
    snapshot: lines.join("\n"),
    refs: payload.refs,
  };
}

async function getPageState(page) {
  return {
    url: page.url(),
    title: await page.title(),
    html: await page.content(),
  };
}

async function getOptionalPageState(page) {
  if (!page || page.isClosed()) return null;
  return getPageState(page);
}

function consoleThreshold(level) {
  const order = { error: 0, warning: 1, info: 2, debug: 3 };
  return order[level || "info"] ?? 2;
}

function consoleLevel(entryType) {
  if (entryType === "error") return 0;
  if (entryType === "warning") return 1;
  if (entryType === "debug") return 3;
  return 2;
}

function renderConsole(entries) {
  return entries.map((entry) => `[${entry.type}] ${entry.text}`).join("\n");
}

function isFetchLike(resourceType) {
  return resourceType === "fetch" || resourceType === "xhr";
}

function renderNetwork(entries, includeStatic) {
  const out = [];
  for (const entry of entries) {
    if (!includeStatic && !isFetchLike(entry.resourceType) && entry.responseStatus > 0 && entry.responseStatus < 400 && !entry.failed) {
      continue;
    }
    if (entry.failed) {
      out.push(`[${entry.method}] ${entry.url} => [FAILED] ${entry.errorText || "Unknown error"}`);
      continue;
    }
    out.push(`[${entry.method}] ${entry.url} => [${entry.responseStatus || 0}] ${entry.responseStatusText || ""}`.trim());
  }
  return out.join("\n");
}

function parseTabIndex(value, action) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`browser_tabs: index is required for action=${action}`);
  }
  return value;
}

async function listTabs(runtime) {
  const activePage = runtime.currentPageOrNull();
  const pages = runtime.openPages();
  return Promise.all(pages.map(async (page, index) => describeTab(runtime, page, index, page === activePage)));
}

async function describeTab(runtime, page, indexOverride, activeOverride) {
  const pages = runtime.openPages();
  const activePage = runtime.currentPageOrNull();
  const index = typeof indexOverride === "number" ? indexOverride : pages.indexOf(page);
  return {
    index,
    active: typeof activeOverride === "boolean" ? activeOverride : page === activePage,
    url: page.url(),
    title: await page.title().catch(() => ""),
  };
}

function firstLivePage(pages, knownPages) {
  for (const page of pages) {
    if (!page || page.isClosed() || knownPages.has(page)) {
      continue;
    }
    return page;
  }
  return null;
}

function recordingSlice(runtime) {
  const ids = runtime.networkOrder().slice(runtime.recordingFromIndex);
  return ids.map((id) => runtime.networkRecords().get(id)).filter(Boolean);
}

function isRecordSettled(record) {
  if (!record) return true;
  if (record.failed) return true;
  if (record.finishedAt) return true;
  return false;
}

async function settleRecordingCapture(runtime, timeoutMs = 2000, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let previousPending = -1;
  let stableSince = Date.now();

  while (Date.now() < deadline) {
    const slice = recordingSlice(runtime);
    const pending = slice.filter((record) => !isRecordSettled(record)).length;
    if (pending === 0) {
      if (Date.now() - stableSince >= 200) return;
    } else if (pending !== previousPending) {
      stableSince = Date.now();
    }
    previousPending = pending;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

module.exports = {
  BrowserRuntime,
};
