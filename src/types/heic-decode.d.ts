declare module "heic-decode" {
  type Decoded = { width: number; height: number; data: Uint8ClampedArray };
  /** One top-level image of the file: its size is known before its pixels are decoded. */
  type Image = { width: number; height: number; decode: () => Promise<Decoded> };
  type Input = { buffer: Uint8Array | ArrayBuffer };
  /** Decode the primary image. */
  function decode(opts: Input): Promise<Decoded>;
  namespace decode {
    /** Every top-level image, undecoded; `dispose()` frees the decoder (call it when done). */
    function all(opts: Input): Promise<Image[] & { dispose: () => void }>;
  }
  export default decode;
}
