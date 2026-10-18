import { expect, it } from 'vitest';
import { canonical } from '../src/api/context';
it('幂等内容归一化稳定且保留数组顺序',()=>{
  expect(canonical({b:[true,null,2],a:{z:'甲',a:false}})).toBe(canonical({a:{a:false,z:'甲'},b:[true,null,2]}));
  expect(canonical([1,2])).not.toBe(canonical([2,1]));
});
it.each([undefined,Infinity,NaN,()=>1])('不能把非法JSON内容归一化成有效请求 %#',value=>expect(()=>canonical(value)).toThrow());
