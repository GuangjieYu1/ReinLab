import {it,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
it('并发首次创建lock只用O_EXCL，已存在重开不携带O_CREAT；无权/链接错误不重试',()=>{
 const result=execFileSync('python3',['-c',`
import ast,pathlib,os,errno
module=ast.parse(pathlib.Path('services/account-runtime/mcp/files.py').read_text())
function=next(n for n in module.body if isinstance(n,ast.FunctionDef) and n.name=='lock_at')
namespace={'os':os};exec(compile(ast.Module(body=[function],type_ignores=[]),'<lock fixture>','exec'),namespace)
original=os.open;calls=[]
def raced(name,flags,*args,**kwargs):
 calls.append(flags)
 if len(calls)==1:raise FileNotFoundError()
 if len(calls)==2:raise FileExistsError()
 return 17
try:
 os.open=raced
 assert namespace['lock_at'](3)==17
 assert len(calls)==3 and not calls[0]&os.O_CREAT and calls[1]&os.O_EXCL and not calls[2]&os.O_CREAT
 for flag in calls:assert flag&os.O_NOFOLLOW and flag&os.O_NONBLOCK
 for error in [PermissionError(),OSError(errno.ELOOP,'fixture')]:
  calls.clear()
  def refused(*args,**kwargs):calls.append(1);raise error
  os.open=refused
  try:namespace['lock_at'](3);raise AssertionError('unsafe retry')
  except (PermissionError,OSError):pass
  assert len(calls)==1
finally:os.open=original
print('LOCK_RACE_GUARDS_OK')
`],{encoding:'utf8'});expect(result.trim()).toBe('LOCK_RACE_GUARDS_OK');
});
