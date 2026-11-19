/* SPDX-License-Identifier: AGPL-3.0-or-later */

var LibraryPreviewPages = class {
  constructor(path) {
    this.path = path;
    this.pages = {};
    this.pending = Promise.resolve();
  }

  async load() {
    try {
      if (await IOUtils.exists(this.path)) {
        const pages = await IOUtils.readJSON(this.path);
        if (!pages || typeof pages !== "object" || Array.isArray(pages)) {
          throw new Error("Invalid preview page settings");
        }
        this.pages = pages;
      }
    }
    catch (error) {
      this.loadError = error;
      Zotero.logError(error);
    }
  }

  key(attachment) {
    return `${attachment.libraryID}/${attachment.key}`;
  }

  get(attachment) {
    const page = this.pages[this.key(attachment)];
    return Number.isSafeInteger(page) && page > 0 ? page : 1;
  }

  registerMenu(pluginID) {
    const english = !Zotero.locale?.startsWith("zh");
    const title = english ? "PDF preview page" : "PDF 预览页";
    const menu = (label, reset) => ({
      menuType: "menuitem",
      onShowing: (_event, context) => {
        context.menuElem.setAttribute("label", label);
        context.setVisible(context.items.some(item =>
          item.isRegularItem() || item.attachmentContentType === "application/pdf"));
      },
      onCommand: (_event, context) => {
        const window = context.menuElem.ownerDocument.defaultView;
        this.command(window, [...context.items], reset, title, english).catch(error => {
          Zotero.logError(error);
          if (!window.closed) Services.prompt.alert(window, title,
            english ? "Could not save preview pages. Check the Zotero error log." : "无法保存预览页。请检查 Zotero 错误日志。");
        });
      }
    });
    return Zotero.MenuManager.registerMenu({
      pluginID,
      menuID: "custom-preview-pages",
      target: "main/library/item",
      menus: [
        menu(english ? "Set preview page…" : "设置预览页…", false),
        menu(english ? "Reset preview to first page" : "恢复首页", true)
      ]
    });
  }

  async command(window, items, reset, title, english) {
    let page = 1;
    if (!reset) {
      const input = { value: "" };
      const message = english
        ? "Enter the PDF page number, counting the first page of the file as 1."
        : "输入 PDF 文件中的页码，从文件首页计为第 1 页。";
      if (!Services.prompt.prompt(window, title, message, input, null, {})) return;
      const value = input.value.trim();
      page = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(page) || page < 1) {
        Services.prompt.alert(window, title,
          english ? "Enter a positive whole page number." : "请输入正整数页码。");
        return;
      }
    }

    const result = await this.apply(window, items, page, reset);
    if (!result || window.closed) return;
    const names = english
      ? { noPDF: "No PDF", tooShort: "Page beyond end of PDF", unreadable: "PDF unavailable or unreadable" }
      : { noPDF: "无 PDF", tooShort: "PDF 页数不足", unreadable: "PDF 不在本地或无法读取" };
    const skipped = Object.values(result.skipped).reduce((total, count) => total + count, 0);
    const summary = english
      ? `Updated ${result.updated} · Skipped ${skipped}`
      : `已更新 ${result.updated} 项 · 跳过 ${skipped} 项`;
    const details = Object.entries(result.skipped).map(([reason, count]) => `${names[reason]} (${count})`);
    Services.prompt.alert(window, title, [summary, ...details].join("\n"));
  }

  apply(window, items, page, reset) {
    const result = this.pending.then(() => this.applyBatch(window, items, page, reset));
    this.pending = result.catch(() => {});
    return result;
  }

  async applyBatch(window, items, page, reset) {
    if (window.closed) return null;
    if (this.loadError) throw this.loadError;
    const engine = reset ? null : new LibraryThumbnails({
      Zotero, window, diskCache: false, maxConcurrentRenders: 1
    });
    const pages = { ...this.pages };
    const seen = new Set();
    const updated = new Set();
    const skipped = {};
    const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    try {
      for (const item of items) {
        if (window.closed) return null;
        try {
          const attachment = item.isRegularItem() ? await item.getBestAttachment() : item;
          if (attachment?.attachmentContentType !== "application/pdf") {
            skip("noPDF");
            continue;
          }
          const key = this.key(attachment);
          if (seen.has(key)) continue;
          seen.add(key);
          if (!reset) {
            const path = await attachment.getFilePathAsync();
            const stat = path && await IOUtils.stat(path);
            if (!stat?.size || stat.size > 256 * 1024 * 1024) {
              skip("unreadable");
              continue;
            }
            const pageCount = await engine.pdfPageCount(path, stat.size);
            if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
              skip("unreadable");
              continue;
            }
            if (page > pageCount) {
              skip("tooShort");
              continue;
            }
          }
          if (page === 1) delete pages[key];
          else pages[key] = page;
          updated.add(attachment.id);
        }
        catch (error) {
          Zotero.logError(error);
          skip("unreadable");
        }
      }
    }
    finally {
      engine?.destroy();
    }
    if (updated.size) {
      await IOUtils.writeJSON(this.path, pages, { tmpPath: this.path + ".tmp" });
      this.pages = pages;
      for (const mainWindow of Zotero.getMainWindows()) {
        const controller = mainWindow.ZoteroIconView;
        if (controller?.engine.previewPages === this) controller.refreshPreviewPages(updated);
      }
    }
    return { updated: updated.size, skipped };
  }
};
