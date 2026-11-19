const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../preview-pages.js"), "utf8");

function fixture() {
  const lengths = new Map([["alpha.pdf", 3], ["beta.pdf", 2], ["short.pdf", 1]]);
  const counts = [], updates = [];
  let saved, writeError;
  const controller = {
    engine: {},
    refreshPreviewPages(ids) { updates.push([...ids]); }
  };
  const scope = vm.createContext({
    Zotero: { getMainWindows: () => [{ ZoteroIconView: controller }], logError() {} },
    IOUtils: {
      exists: async () => saved !== undefined,
      readJSON: async () => JSON.parse(saved),
      stat: async file => ({ size: lengths.has(file) ? 100 : 0 }),
      async writeJSON(_path, pages) {
        await Promise.resolve();
        if (writeError) throw writeError;
        saved = JSON.stringify(pages);
      }
    },
    LibraryThumbnails: class {
      async pdfPageCount(file) { counts.push(file); return lengths.get(file); }
      destroy() {}
    }
  });
  vm.runInContext(source, scope);
  const reopen = () => new scope.LibraryPreviewPages("test-pages.json");
  const pages = reopen();
  controller.engine.previewPages = pages;
  return { pages, reopen, counts, updates, failWrite(error) { writeError = error; } };
}

function pdf(id, file) {
  return { id, libraryID: 1, key: "PDF" + id, attachmentContentType: "application/pdf",
    isRegularItem: () => false, getFilePathAsync: async () => file };
}

test("a mixed batch deduplicates attachments, skips invalid destinations, and persists valid pages", async () => {
  const { pages, reopen, counts, updates } = fixture();
  const alpha = pdf(1, "alpha.pdf"), beta = pdf(2, "beta.pdf"), short = pdf(3, "short.pdf");
  const parent = { isRegularItem: () => true, getBestAttachment: async () => alpha };
  const noPDF = { isRegularItem: () => true, getBestAttachment: async () => null };
  const { updated, skipped } = await pages.apply({}, [parent, alpha, beta, short, pdf(4, "missing.pdf"), noPDF], 2, false);
  assert.equal(updated, 2);
  assert.deepEqual({ ...skipped }, { tooShort: 1, unreadable: 1, noPDF: 1 });
  assert.deepEqual(counts, ["alpha.pdf", "beta.pdf", "short.pdf"]);
  assert.deepEqual(updates, [[1, 2]]);
  const restored = reopen();
  await restored.load();
  assert.equal(restored.get(alpha), 2);
  assert.equal(restored.get(beta), 2);
  assert.equal(restored.get(short), 1);
});

test("failed writes keep the active preview and queued changes execute in order", async () => {
  const { pages, failWrite, updates } = fixture();
  const alpha = pdf(1, "alpha.pdf");
  await pages.apply({}, [alpha], 2, false);
  failWrite(new Error("fixture write failed"));
  await assert.rejects(pages.apply({}, [alpha], 3, false), /fixture write failed/);
  assert.equal(pages.get(alpha), 2);
  assert.deepEqual(updates, [[1]]);
  failWrite(null);
  await Promise.all([pages.apply({}, [alpha], 3, false), pages.apply({}, [alpha], 1, true)]);
  assert.equal(pages.get(alpha), 1);
  assert.deepEqual(updates, [[1], [1], [1]]);
});
