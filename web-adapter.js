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
  const workerCount = Math.min(2, Math.max(1, navigator.hardwareConcurrency || 2));
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
    if (!result) return result;
    const cleaned = { ...result };
    delete cleaned.optimizationRank;
    delete cleaned.statFirstAlternatives;
    delete cleaned.statFirstCandidateSets;
    return cleaned;
  };

  const statPriorityOrder = request => {
    const indexes = { "weapon damage": 0, weapondamage: 0, damage: 0, attack: 1, defense: 2, defence: 2, health: 3 };
    const order = (request.statPriority || []).map(value => indexes[String(value).toLowerCase().replace(/\s+/g, " ")]);
    return order.length === 4 && new Set(order).size === 4 && order.every(index => index !== undefined) ? order : [0, 1, 2, 3];
  };

  const statFirstValue = (alternative, index) => {
    const rank = alternative.optimizationRank;
    if (!rank) return 0;
    return Number(rank.stats?.[index] || 0) + (index === 1 ? Number(rank.damage || 0) + Number(rank.defensePenetration || 0) * 3 : 0);
  };

  const selectStatFirstAlternative = (request, alternatives) => {
    if (!alternatives.length) return null;
    const minimum = Array(4).fill(Infinity);
    const maximum = Array(4).fill(-Infinity);
    for (const alternative of alternatives) {
      for (let index = 0; index < 4; index++) {
        const value = statFirstValue(alternative, index);
        minimum[index] = Math.min(minimum[index], value);
        maximum[index] = Math.max(maximum[index], value);
      }
    }
    const order = statPriorityOrder(request);
    const scored = alternatives.map(alternative => {
      let weight = 1;
      let score = 0;
      for (const index of order) {
        const value = statFirstValue(alternative, index);
        score += weight * (maximum[index] > minimum[index] ? (value - minimum[index]) / (maximum[index] - minimum[index]) : 0);
        weight *= 0.1;
      }
      return { ...alternative, score, price: Number(alternative.optimizationRank?.averagePrice || 0) };
    });
    const referenceCost = Number(request.statFirstReferenceCost || request.statFirstCostCeiling || 0);
    const underBudget = referenceCost > 0 ? scored.filter(alternative => alternative.price <= referenceCost * 1.1) : scored;
    const eligible = referenceCost > 0 && underBudget.length ? underBudget : scored;
    eligible.sort((left, right) => left.price - right.price || right.score - left.score);
    const frontier = [];
    let bestScore = -1;
    for (const alternative of eligible) {
      if (alternative.score > bestScore) {
        frontier.push(alternative);
        bestScore = alternative.score;
      }
    }
    let selected = frontier[0];
    let lowGain = 0;
    let lastGain = -1;
    for (let index = 1; index < frontier.length; index++) {
      const previous = frontier[index - 1];
      const candidate = frontier[index];
      const priceDelta = candidate.price - previous.price;
      const gain = priceDelta > 0 ? (candidate.score - previous.score) / priceDelta : 0;
      if (lastGain >= 0 && gain <= lastGain / 4) {
        lowGain++;
        if (lowGain >= 3) break;
      } else {
        lowGain = 0;
        selected = candidate;
      }
      lastGain = gain;
    }
    return { selected, scored, ranked: eligible, frontier, fallback: referenceCost > 0 && !underBudget.length };
  };

  const mergeStatFirstDebug = (results, selection, request) => {
    const candidates = new Map();
    for (const result of results) {
      for (const candidate of result.debug?.candidates || []) {
        const previous = candidates.get(candidate.number);
        if (!previous || previous.status === "UNTESTED") candidates.set(candidate.number, candidate);
      }
    }
    const scoreByNumber = new Map(selection.scored.filter(candidate => candidate.candidateNumber > 0).map(candidate => [candidate.candidateNumber, candidate.score]));
    const ranked = new Set(selection.ranked.filter(candidate => candidate.candidateNumber > 0).map(candidate => candidate.candidateNumber));
    const frontier = new Set(selection.frontier.filter(candidate => candidate.candidateNumber > 0).map(candidate => candidate.candidateNumber));
    const referenceCost = Number(request.statFirstReferenceCost || request.statFirstCostCeiling || 0);
    const upper = referenceCost * 1.1;
    for (const candidate of candidates.values()) {
      if (scoreByNumber.has(candidate.number)) candidate.score = scoreByNumber.get(candidate.number);
      candidate.ranked = ranked.has(candidate.number);
      candidate.frontier = frontier.has(candidate.number);
      candidate.selected = selection.selected.candidateNumber === candidate.number;
      if (!selection.fallback && referenceCost > 0 && candidate.status === "valid" && candidate.price > upper) candidate.status = "OVER BUDGET";
    }
    return { candidates: [...candidates.values()].sort((left, right) => left.number - right.number) };
  };

  const execute = request => {
    if (workerCount === 1) {
      return call(primaryWorker, "execute", request).then(result => {
        for (const listener of listeners) listener({ data: { milestone: "Worker 1 finished." } });
        return stripRank(result);
      });
    }
    const progress = Array(workerCount).fill(null);
    workers.slice(0, workerCount).forEach((state, shard) => {
      state.progress = update => {
        progress[shard] = update;
        const tested = progress.reduce((total, value) => total + (value?.tested || 0), 0);
        for (const listener of listeners) listener({ data: { ...update, tested } });
      };
    });
    const run = (state, shard, candidateSets, generateOnly = false) => call(state, "execute", {
      ...request,
      ...(request.statFirst
        ? { searchShard: 0, searchShards: 1, statFirstCandidateShard: shard, statFirstCandidateShards: workerCount, ...(candidateSets ? { statFirstCandidates: candidateSets } : {}), ...(generateOnly ? { statFirstGenerateOnly: true } : {}) }
        : { searchShard: shard, searchShards: workerCount })
    }).then(result => {
      for (const listener of listeners) listener({ data: { milestone: `Worker ${shard + 1} finished.` } });
      return result;
    });
    const searches = request.statFirst
      ? run(workers[0], 0, undefined, true).then(first => Promise.all(
        workers.slice(0, workerCount).map((state, shard) => run(state, shard, first.statFirstCandidateSets))
      ))
      : Promise.all(workers.slice(0, workerCount).map((state, shard) => run(state, shard)));
    return searches.then(results => {
      const possible = results.filter(result => result.possible);
      const selected = possible.reduce((best, result) => !best || compareResults(result, best) > 0 ? result : best, null) || results[0];
      const merged = {
        ...selected,
        tested: results.reduce((total, result) => total + (result.tested || 0), 0),
        seconds: Math.max(...results.map(result => result.seconds || 0))
      };
      if (request.statFirst) {
        const alternatives = results.flatMap(result => result.statFirstAlternatives || []);
        const selection = selectStatFirstAlternative(request, alternatives);
        if (selection) {
          merged.possible = selection.selected.possible;
          merged.closest = selection.selected.closest;
          merged.distance = selection.selected.distance;
          merged.sets = selection.selected.sets;
          merged.optimizationRank = selection.selected.optimizationRank;
          merged.debug = mergeStatFirstDebug(results, selection, request);
        }
      }
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
