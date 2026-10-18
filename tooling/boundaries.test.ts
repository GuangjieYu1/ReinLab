import { describe, expect, it } from 'vitest';
import { checkSource, checkManifest } from './boundaries';

describe('依赖边界', () => {
  it.each([
    "import {x} from '@synsci/sdk'", "export * from '@synsci/sdk/v2'",
    "const x = import('@synsci/sdk')", "const x = require('@synsci/sdk')",
    "import type {X} from '@synsci/sdk'", "import x = require('@synsci/sdk')",
    "const x = import('@synsci/' + 'sdk')", "const x = require(name)",
  ])('控制面越界：%s', source => expect(checkSource('services/control/src/api/a.ts', source)).not.toEqual([]));
  it('翻译层允许 SDK', () => expect(checkSource('services/control/src/bridge/openscience/a.ts', "import {x} from '@synsci/sdk'" )).toEqual([]));
  it.each(['../../services/control/src/main', '@reinlab/control', '@synsci/openscience', '@synsci/plugin'])('前端禁止 %s', spec => expect(checkSource('src/lib/a.ts', `import x from '${spec}'`)).not.toEqual([]));
  it('前端允许共享契约', () => expect(checkSource('src/lib/a.ts', "import {x} from '@reinlab/contracts'" )).toEqual([]));
  it.each(['hono', 'pg', '@reinlab/control', '@synsci/sdk'])('契约禁止服务端包 %s', spec => expect(checkSource('packages/contracts/src/a.ts', `export * from '${spec}'`)).not.toEqual([]));
  it('契约不能经相对路径越界', () => expect(checkSource('packages/contracts/src/a.ts', "import x from '../../../services/control/src/a'" )).not.toEqual([]));
  it('注释不触发误报', () => expect(checkSource('src/a.ts', "// import x from '@synsci/sdk'" )).toEqual([]));
  it('manifest 也受边界约束', () => expect(checkManifest('packages/contracts/package.json', { dependencies: { hono: '1' } })).not.toEqual([]));
  it.each([
    "module.require('@synsci/sdk')", "const load = require; load('@synsci/sdk')",
    "import {createRequire} from 'node:module'", "import x from '../../../node_modules/@synsci/sdk/index.js'",
    "const x = globalThis['require']('@synsci/sdk')",
  ])('禁止模块加载绕过：%s', source => expect(checkSource('services/control/src/api/a.ts', source)).not.toEqual([]));
  it('前端禁止绝对路径', () => expect(checkSource('src/a.ts', "import x from '/services/control/a'" )).not.toEqual([]));
  it('禁止 SDK 包别名', () => expect(checkManifest('services/control/package.json', { dependencies: { os: 'npm:@synsci/sdk@2.0.150' } })).not.toEqual([]));
  it('解析 tsconfig alias 后仍禁止 SDK', () => expect(checkSource('services/control/src/api/a.ts', "import x from 'sdkAlias'", () => 'node_modules/@synsci/sdk/index.d.ts')).not.toEqual([]));
  it('前端禁止解析后的服务 alias', () => expect(checkSource('src/a.ts', "import x from 'backendAlias'", () => 'services/control/src/a.ts')).not.toEqual([]));
  it('不能借助括号 require', () => expect(checkSource('services/control/src/a.ts', "(require)('@synsci/sdk')")).not.toEqual([]));
  it.each([
    "module['requ' + 'ire']('@synsci/sdk')",
    "module[`requ${'ire'}`]('@synsci/sdk')",
    "process.getBuiltinModule('module').createRequire(import.meta.url)('@synsci/sdk')",
    "process['getBuiltin' + 'Module']('module').createRequire(import.meta.url)('@synsci/sdk')",
    "import('file:///tmp/node_modules/%40synsci/sdk/index.js')",
    "(module)['requ' + 'ire']('@synsci/sdk')",
    "let loader; loader = module; loader['requ' + 'ire']('@synsci/sdk')",
    "module.constructor._load('@synsci/sdk', module)",
    "declare const module: any; (module)['requ' + 'ire']('@synsci/sdk')",
    "var module: any; module['requ' + 'ire']('@synsci/sdk')",
    "const p=process; p['getBuiltin'+'Module']('module').createRequire(import.meta.url)('@synsci/sdk')",
    "const g=globalThis.global; const p=g['pro'+'cess']; p['getBuiltin'+'Module']('module').createRequire(import.meta.url)('@synsci/sdk')",
  ])('拒绝计算加载器与编码 URL：%s', source => expect(checkSource('services/control/src/a.ts', source)).not.toEqual([]));
  it('局部 module 变量不是加载器', () => expect(checkSource('src/a.ts', 'const module = { title: "实验" }; console.log(module.title)')).toEqual([]));
  it('module 字段不是加载器', () => expect(checkSource('src/a.ts', 'type X = { module: string }; const x: X = { module: "实验" }; console.log(x.module)')).toEqual([]));
});
