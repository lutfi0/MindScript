// Re-exported type surface for the vendored transformers.js bundle.
// vendor.d.ts declares the module; this shim gives engine.ts a single
// importable type (erased at compile time).
export type TransformersModule = {
  pipeline: (
    task: string,
    model: string,
    opts?: Record<string, unknown>,
  ) => Promise<(audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string }>>;
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
    backends: { onnx: { wasm: { wasmPaths: string } } };
  };
};
