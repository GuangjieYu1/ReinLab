declare module "subset-font" {
  /** 用 harfbuzz 把字体裁剪到给定文本用到的字。 */
  export default function subsetFont(
    font: Buffer | Uint8Array,
    text: string,
    options?: { targetFormat?: "woff2" | "woff" | "sfnt" | "truetype"; preserveNameIds?: number[] },
  ): Promise<Buffer>;
}
