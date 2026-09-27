/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OpenMAIC 站点地址，例如 https://open.maic.chat。未设置时终端不会跳转。 */
  readonly VITE_OPENMAIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
