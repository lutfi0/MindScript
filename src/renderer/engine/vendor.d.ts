// Type surface of the vendored transformers.js ESM bundle.
declare module '*.min.js' {
  export const pipeline: (
    task: string,
    model: string,
    opts?: Record<string, unknown>,
  ) => Promise<
    (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string }>
  >;
  export const env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
    backends: { onnx: { wasm: { wasmPaths: string } } };
  };
}
