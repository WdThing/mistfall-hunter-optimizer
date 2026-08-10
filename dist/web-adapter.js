(() => {
  window.mistfallWeb = true;
  const sessionKey = "mistfall-hunter-affix-session";
  const resultsKey = "mistfall-hunter-affix-results";
  const listeners = new Set();

  window.mistfallProgress = progress => {
    for (const listener of listeners) listener({ data: progress });
  };

  const loadJSON = key => JSON.parse(localStorage.getItem(key) || "null");
  const saveJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const ready = (async () => {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "wasm_exec.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load wasm_exec.js"));
      document.head.append(script);
    });
    const go = new Go();
    const response = await fetch("mistfall.wasm");
    const result = await WebAssembly.instantiateStreaming(response, go.importObject);
    go.run(result.instance);
    while (!window.mistfallCore) await new Promise(resolve => setTimeout(resolve, 10));
    const [database, affixes] = await Promise.all(["database.json", "affixes.json"].map(async path => {
      const response = await fetch(path);
      if (!response.ok) throw new Error("Could not load " + path);
      return new Uint8Array(await response.arrayBuffer());
    }));
    const error = window.mistfallCore.init(database, affixes);
    if (error) throw new Error(error);
  })();

  const GUIService = {
    GetOptions: () => ready.then(() => window.mistfallCore.getOptions()),
    Execute: request => ready.then(() => window.mistfallCore.execute(request)),
    LoadSession: () => ready.then(() => loadJSON(sessionKey) || {}),
    SaveSession: session => ready.then(() => saveJSON(sessionKey, session)),
    ListResults: () => ready.then(() => Object.entries(loadJSON(resultsKey) || {})
      .map(([name, value]) => ({ name, createdAt: value.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    LoadResult: name => ready.then(() => {
      const result = (loadJSON(resultsKey) || {})[name];
      if (!result) throw new Error("saved result " + name + " was not found");
      return result.session;
    }),
    SaveResult: (name, session) => ready.then(() => {
      name = name.trim();
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error("result name must be a file name");
      if (!session.hasResult || !session.result?.possible) throw new Error("only successful results can be saved");
      const results = loadJSON(resultsKey) || {};
      if (results[name]) throw new Error("result " + name + " already exists");
      results[name] = { createdAt: new Date().toISOString(), session };
      saveJSON(resultsKey, results);
    }),
    DeleteResult: name => ready.then(() => {
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
