// Wrangler bundles these binary imports (see `rules` in wrangler.toml): a
// `.wasm` file becomes a WebAssembly.Module, a `.ttf` file an ArrayBuffer.
declare module '*.wasm' {
  const mod: WebAssembly.Module;
  export default mod;
}
declare module '*.ttf' {
  const buf: ArrayBuffer;
  export default buf;
}
