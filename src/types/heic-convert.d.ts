declare module "heic-convert" {
  type Options = { buffer: Uint8Array | ArrayBuffer; format: "JPEG" | "PNG"; quality?: number };
  function convert(opts: Options): Promise<ArrayBuffer | Uint8Array>;
  export default convert;
}
