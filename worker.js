importScripts("wasm_exec.js");

const ready = (async () => {
  const go = new Go();
  const response = await fetch("mistfall.wasm");
  const result = await WebAssembly.instantiateStreaming(response, go.importObject);
  go.run(result.instance);
  while (!self.mistfallCore) await new Promise(resolve => setTimeout(resolve, 10));
  const [database, affixes] = await Promise.all(["database.json", "affixes.json"].map(async path => {
    const response = await fetch(path);
    if (!response.ok) throw new Error("Could not load " + path);
    return new Uint8Array(await response.arrayBuffer());
  }));
  const error = self.mistfallCore.init(database, affixes);
  if (error) throw new Error(error);
})();

self.mistfallProgress = progress => postMessage({ type: "progress", progress });

onmessage = async ({ data }) => {
  try {
    await ready;
    const result = await self.mistfallCore[data.method](...data.args);
    postMessage({ id: data.id, result });
  } catch (error) {
    postMessage({ id: data.id, error: String(error) });
  }
};
