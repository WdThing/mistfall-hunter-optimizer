(() => {
  window.mistfallWeb = true;
  const sessionKey = "mistfall-hunter-affix-session";
  const resultsKey = "mistfall-hunter-affix-results";
  const listeners = new Set();
  const worker = new Worker("worker.js");
  const pending = new Map();
  let nextRequestID = 0;

  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      for (const listener of listeners) listener({ data: data.progress });
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };

  const loadJSON = key => JSON.parse(localStorage.getItem(key) || "null");
  const saveJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++nextRequestID;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, method, args });
  });

  const GUIService = {
    GetOptions: () => call("getOptions"),
    Execute: request => call("execute", request),
    ExportCode: session => call("exportCode", session),
    ImportCode: code => call("importCode", code),
    LoadSession: () => Promise.resolve(loadJSON(sessionKey) || {}),
    SaveSession: session => Promise.resolve(saveJSON(sessionKey, session)),
    ListResults: () => Promise.resolve(Object.entries(loadJSON(resultsKey) || {})
      .map(([name, value]) => ({ name, createdAt: value.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    LoadResult: name => Promise.resolve().then(() => {
      const result = (loadJSON(resultsKey) || {})[name];
      if (!result) throw new Error("saved result " + name + " was not found");
      return result.session;
    }),
    SaveResult: (name, session) => Promise.resolve().then(() => {
      name = name.trim();
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error("result name must be a file name");
      if (!session.hasResult || !session.result?.possible) throw new Error("only successful results can be saved");
      const results = loadJSON(resultsKey) || {};
      results[name] = { createdAt: new Date().toISOString(), session };
      saveJSON(resultsKey, results);
    }),
    DeleteResult: name => Promise.resolve().then(() => {
      const results = loadJSON(resultsKey) || {};
      if (!results[name]) throw new Error("saved result " + name + " was not found");
      delete results[name];
      saveJSON(resultsKey, results);
    })
  };

  window.MistfallWeb = {
    GUIService,
    Events: {
      On(name, listener) {
        if (name !== "optimization-progress") return;
        listeners.add(listener);
      }
    }
  };
})();
