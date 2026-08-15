importScripts("wasm_exec.js");

const ready = (async () => {
  const go = new Go();
  const response = await fetch("mistfall.wasm");
  const result = await WebAssembly.instantiateStreaming(response, go.importObject);
  go.run(result.instance);
  while (!self.mistfallCore) await new Promise(resolve => setTimeout(resolve, 10));
  const error = self.mistfallCore.init();
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
