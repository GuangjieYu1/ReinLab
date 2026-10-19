import {ApiFailure} from '../api/errors';
const maximum=999999999999n,aggregateMaximum=999999999999999999n;
function parse(value:unknown,ceiling:bigint):bigint {
  if(typeof value!=='string'&&typeof value!=='number')throw invalid();
  const text=String(value);if(text.length>64)throw invalid();const match=/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if(!match)throw invalid();
  const digits=match[1]+(match[2]??''),shift=6-(match[2]?.length??0)+Number(match[3]??0);
  if(!Number.isSafeInteger(shift)||Math.abs(shift)>30)throw invalid();
  let result=BigInt(digits);
  if(shift<0){const divisor=10n**BigInt(-shift);if(result%divisor!==0n)throw invalid();result/=divisor;}else result*=10n**BigInt(shift);
  if(result>ceiling)throw invalid();return result;
}
export const micros=(value:unknown)=>parse(value,maximum);
export const totalMicros=(value:unknown)=>parse(value,aggregateMaximum);
function invalid(){return new ApiFailure('INVALID_INPUT',400,'金额必须是非负、最多六位小数且不超过999999.999999的有限值。');}
export function decimal(value:bigint):string {
  const sign=value<0n?'-':'',positive=value<0n?-value:value;return sign+String(positive/1000000n)+'.'+String(positive%1000000n).padStart(6,'0');
}
export const cny=(value:unknown)=>decimal(totalMicros(value));
