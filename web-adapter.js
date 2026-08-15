(() => {
  window.mistfallWeb = true;
  const sessionKey = "mistfall-hunter-affix-session";
  const resultsKey = "mistfall-hunter-affix-results";
  const listeners = new Set();
  const workers = [];
  let nextRequestID = 0;

  const createWorker = () => {
    const state = { worker: new Worker("worker.js"), pending: new Map(), progress: null };
    state.worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        if (state.progress) state.progress(data.progress);
        else for (const listener of listeners) listener({ data: data.progress });
        return;
      }
      const request = state.pending.get(data.id);
      if (!request) return;
      state.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    workers.push(state);
    return state;
  };

  const primaryWorker = createWorker();
  const workerCount = Math.min(4, Math.max(1, navigator.hardwareConcurrency || 2));
  while (workers.length < workerCount) createWorker();

  const loadJSON = key => JSON.parse(localStorage.getItem(key) || "null");
  const saveJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const call = (state, method, ...args) => new Promise((resolve, reject) => {
    const id = ++nextRequestID;
    state.pending.set(id, { resolve, reject });
    state.worker.postMessage({ id, method, args });
  });

  const compareResults = (candidate, current) => {
    const candidateDistance = candidate.distance || 0;
    const currentDistance = current.distance || 0;
    if (candidateDistance !== currentDistance) return candidateDistance < currentDistance ? 1 : -1;
    const left = candidate.optimizationRank;
    const right = current.optimizationRank;
    if (!left || !right) return 0;
    if (left.raritySum !== right.raritySum) return left.raritySum < right.raritySum ? 1 : -1;
    const order = left.statOrder || [0, 1, 2, 3];
    for (const index of order) {
      if (left.stats[index] !== right.stats[index]) return left.stats[index] > right.stats[index] ? 1 : -1;
      if (index === 1 && left.damage !== right.damage) return left.damage > right.damage ? 1 : -1;
    }
    if (left.tierDeficit !== right.tierDeficit) return left.tierDeficit < right.tierDeficit ? 1 : -1;
    if (left.signature !== right.signature) return left.signature < right.signature ? 1 : -1;
    return 0;
  };

  const stripRank = result => {
    if (!result?.optimizationRank) return result;
    const cleaned = { ...result };
    delete cleaned.optimizationRank;
    return cleaned;
  };

  const execute = request => {
    if (workerCount === 1) return call(primaryWorker, "execute", request).then(stripRank);
    const progress = Array(workerCount).fill(null);
    workers.slice(0, workerCount).forEach((state, shard) => {
      state.progress = update => {
        progress[shard] = update;
        const tested = progress.reduce((total, value) => total + (value?.tested || 0), 0);
        for (const listener of listeners) listener({ data: { ...update, tested } });
      };
    });
    const searches = workers.slice(0, workerCount).map((state, shard) => call(state, "execute", {
      ...request,
      searchShard: shard,
      searchShards: workerCount
    }));
    return Promise.all(searches).then(results => {
      const possible = results.filter(result => result.possible);
      const selected = possible.reduce((best, result) => !best || compareResults(result, best) > 0 ? result : best, null) || results[0];
      const merged = {
        ...selected,
        tested: results.reduce((total, result) => total + (result.tested || 0), 0),
        seconds: Math.max(...results.map(result => result.seconds || 0))
      };
      return stripRank(merged);
    }).finally(() => workers.slice(0, workerCount).forEach(state => { state.progress = null; }));
  };

  const GUIService = {
    GetOptions: () => call(primaryWorker, "getOptions"),
    Execute: execute,
    ExportCode: session => call(primaryWorker, "exportCode", session),
    ImportCode: code => call(primaryWorker, "importCode", code),
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
