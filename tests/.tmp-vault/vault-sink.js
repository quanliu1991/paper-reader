// electron/vault-sink.ts
import fs from "fs";
import path from "path";
function taskKey(t) {
  return `${t.kind}:${t.paperId ?? t.topicId ?? ""}`;
}
function writeJournal(p, tasks) {
  const lines = tasks.map((t) => JSON.stringify(t)).join("\n");
  fs.writeFileSync(p, lines ? lines + "\n" : "");
}
function appendJournal(p, task) {
  try {
    fs.appendFileSync(p, JSON.stringify(task) + "\n");
  } catch {
  }
}
function readJournal(p) {
  try {
    const text = fs.readFileSync(p, "utf8").trim();
    if (!text) return [];
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}
function createSink(opts) {
  const internal = {
    queue: /* @__PURE__ */ new Map(),
    timer: null,
    flushing: null,
    errors: 0,
    lastError: void 0,
    retries: /* @__PURE__ */ new Map(),
    opts: { flush: opts.flush, journalPath: opts.journalPath, delayMs: opts.delayMs ?? 800 }
  };
  if (internal.opts.journalPath) {
    const pending = readJournal(internal.opts.journalPath);
    for (const t of pending) internal.queue.set(taskKey(t), t);
  }
  async function drain() {
    if (internal.queue.size === 0) {
      if (internal.opts.journalPath) writeJournal(internal.opts.journalPath, []);
      return;
    }
    const batch = [...internal.queue.values()];
    internal.queue.clear();
    try {
      await internal.opts.flush(batch);
      if (internal.opts.journalPath) writeJournal(internal.opts.journalPath, [...internal.queue.values()]);
      for (const t of batch) internal.retries.delete(taskKey(t));
    } catch (err) {
      internal.errors += 1;
      internal.lastError = String(err?.message ?? err);
      for (const t of batch) {
        const key = taskKey(t);
        const n = internal.retries.get(key) ?? 0;
        if (n < 1) {
          internal.retries.set(key, n + 1);
          internal.queue.set(key, t);
        }
      }
      if (internal.queue.size > 0 && !internal.timer) {
        internal.timer = setTimeout(() => {
          internal.timer = null;
          void drain();
        }, internal.opts.delayMs);
        internal.timer.unref?.();
      }
    }
  }
  return {
    enqueue(task) {
      internal.queue.set(taskKey(task), task);
      if (internal.opts.journalPath) appendJournal(internal.opts.journalPath, task);
      if (internal.timer) clearTimeout(internal.timer);
      internal.timer = setTimeout(() => {
        internal.timer = null;
        void drain();
      }, internal.opts.delayMs);
      internal.timer.unref?.();
    },
    flush() {
      if (internal.timer) {
        clearTimeout(internal.timer);
        internal.timer = null;
      }
      internal.flushing = (internal.flushing ?? Promise.resolve()).then(() => drain());
      return internal.flushing;
    },
    stats() {
      const s = { pending: internal.queue.size, errors: internal.errors };
      if (internal.lastError !== void 0) s.lastError = internal.lastError;
      return s;
    }
  };
}
function vaultPaths(vaultDir) {
  return {
    root: vaultDir,
    papersDir: path.join(vaultDir, "papers"),
    topicsDir: path.join(vaultDir, "topics"),
    glossaryDir: path.join(vaultDir, "glossary"),
    trashDir: path.join(vaultDir, "trash"),
    flashcards: path.join(vaultDir, "flashcards.jsonl"),
    profile: path.join(vaultDir, "profile.md"),
    paperDir: (key) => path.join(vaultDir, "papers", key),
    meta: (key) => path.join(vaultDir, "papers", key, "meta.yaml"),
    annotations: (key) => path.join(vaultDir, "papers", key, "annotations.json"),
    notes: (key) => path.join(vaultDir, "papers", key, "notes.md"),
    qa: (key) => path.join(vaultDir, "papers", key, "qa.jsonl"),
    translations: (key) => path.join(vaultDir, "papers", key, "translations.jsonl"),
    digest: (key) => path.join(vaultDir, "papers", key, "digest.md"),
    topicJson: (slug) => path.join(vaultDir, "topics", `${slug}.json`),
    topicDigest: (slug) => path.join(vaultDir, "topics", `${slug}.digest.md`)
  };
}
export {
  createSink,
  vaultPaths
};
