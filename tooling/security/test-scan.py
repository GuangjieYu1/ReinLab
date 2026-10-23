import io, unittest, importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('credential_scan',Path(__file__).with_name('scan-mcp-credentials.py'))
scanner=importlib.util.module_from_spec(spec);spec.loader.exec_module(scanner)
class ScannerTests(unittest.TestCase):
    def test_streaming_boundary_and_exact_counts(self):
        value='fixture-value-for-unit-test'
        source=b'x'*(1024*1024-5)+value.encode()+b'z'*10+value.encode()
        self.assertEqual(scanner.scan_stream(io.BytesIO(source),{'fixture':value}),{'fixture':2})
    def test_json_escaped_value_and_absent_value(self):
        import json
        value='fixture-multiline\nsecond-line'
        source=json.dumps({'key':value}).encode()
        self.assertEqual(scanner.scan_stream(io.BytesIO(source),{'fixture':value,'absent':'not-present-in-fixture'}),{'fixture':1,'absent':0})
    def test_no_overlap_recount_for_short_values(self):
        value='fixture-short-value'
        source=b'x'*(1024*1024-len(value))+value.encode()+b'y'*100
        self.assertEqual(scanner.scan_stream(io.BytesIO(source),{'fixture':value,'long':'A'*300}),{'fixture':1,'long':0})
    def test_missing_required_scope_is_incomplete(self):
        scope={'available':False,'required':True,'readErrors':0,'matchingFiles':0}
        self.assertEqual(scanner.audit_status({'evidence':scope}),'incomplete')
        self.assertEqual(scanner.audit_status({'optional':{**scope,'required':False}}),'passed')
    def test_fifo_and_symlink_are_rejected_without_blocking(self):
        import os,tempfile
        with tempfile.TemporaryDirectory() as directory:
            fifo=Path(directory)/'fifo';os.mkfifo(fifo)
            with self.assertRaises(ValueError):scanner.scan_file(fifo,{'fixture':'value'})
            linked=Path(directory)/'linked';linked.symlink_to(fifo)
            with self.assertRaises(OSError):scanner.scan_file(linked,{'fixture':'value'})
    def test_git_diagnostic_stderr_is_suppressed(self):
        from unittest.mock import patch
        import subprocess
        with patch.object(scanner.subprocess,'check_output',return_value=b'abc fixture\n') as call:
            self.assertEqual(scanner.git_objects('/fixture'),[b'abc'])
            self.assertEqual(call.call_args.kwargs['stderr'],subprocess.DEVNULL)
    def test_unreadable_subdirectory_marks_incomplete_without_diagnostics(self):
        from unittest.mock import patch
        import tempfile
        def walk(_base,**kwargs):
            kwargs['onerror'](PermissionError('synthetic-selected-value-must-not-be-output'))
            return iter([])
        with tempfile.TemporaryDirectory() as directory,patch.object(scanner.os,'walk',side_effect=walk):
            scope=scanner.scan_tree(Path(directory),{'fixture':'synthetic-selected-value'})
            self.assertEqual(scope['readErrors'],1)
            self.assertEqual(scanner.audit_status({'worktree':scope}),'incomplete')
    def test_account_root_requires_nonempty_private_bound_identity(self):
        import os,tempfile,json,uuid
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();root.chmod(0o700)
            with self.assertRaises(ValueError):scanner.account_values(root)
            account=str(uuid.uuid4());folder=root/account;folder.mkdir(mode=0o700)
            file=folder/'account.json';file.write_text(json.dumps({'schema':'account_credentials@1','accountId':account,'auth':'A'*43,'container':'B'*43}));file.chmod(0o600)
            values,count=scanner.account_values(root);self.assertEqual(count,1);self.assertEqual(len(values),2)
            for target,mode in [(root,0o755),(folder,0o755),(file,0o400)]:
                target.chmod(mode)
                with self.assertRaises(ValueError):scanner.account_values(root)
                target.chmod(0o600 if target==file else 0o700)
            file.write_text(json.dumps({'schema':'account_credentials@1','accountId':str(uuid.uuid4()),'auth':'A'*43,'container':'B'*43}))
            with self.assertRaises(ValueError):scanner.account_values(root)
    def test_report_refuses_links_and_preserves_target(self):
        import os,tempfile
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);target=root/'original';target.write_text('unchanged');link=root/'linked';link.symlink_to(target)
            with self.assertRaises(ValueError):scanner.publish_report(link,{'count':0})
            link.unlink();os.link(target,link)
            with self.assertRaises(ValueError):scanner.publish_report(link,{'count':0})
            self.assertEqual(target.read_text(),'unchanged')
            output=root/'report.json';scanner.publish_report(output,{'count':0});self.assertEqual(output.stat().st_mode&0o777,0o600)
if __name__=='__main__':unittest.main()
