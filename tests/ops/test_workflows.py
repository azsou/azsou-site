"""站长第三轮 ⑤：受保护、仅手动触发的备份工作流（运维 PR #8 与 PR #5 共用同一份）。

python3 -m unittest tests/ops/test_workflows.py
断言 .github/workflows/db-backup.yml：只有 workflow_dispatch（无 schedule / push / workflow_call 等）、必填的项目 ref 确认输入、
job 在环境 backup-production、并发组、最小权限、闸门脚本是第一个执行的业务步骤、强制加密、只上传 .gpg、保留 ≥ 30 天；
每日定时 / 外部存储 / 监控只在 ops/disabled-workflows/（GitHub 不运行）。
"""
import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WF = ROOT / '.github' / 'workflows'
DISABLED = ROOT / 'ops' / 'disabled-workflows'


def load(p):
    d = yaml.safe_load(p.read_text(encoding='utf-8'))
    # YAML 1.1 把键 on 解析成 True
    if True in d:
        d['on'] = d.pop(True)
    return d


class ProtectedBackupWorkflow(unittest.TestCase):
    def setUp(self):
        self.text = (WF / 'db-backup.yml').read_text(encoding='utf-8')
        self.wf = load(WF / 'db-backup.yml')
        self.job = self.wf['jobs']['backup']

    def test_only_workflow_dispatch(self):
        self.assertEqual(set(self.wf['on'].keys()), {'workflow_dispatch'})
        self.assertNotRegex(self.text, r'(?m)^\s*-?\s*cron\s*:')
        self.assertNotIn('schedule', self.wf['on'])

    def test_confirm_input_required(self):
        inp = self.wf['on']['workflow_dispatch']['inputs']['confirm_project_ref']
        self.assertTrue(inp['required'])
        self.assertEqual(inp['type'], 'string')
        self.assertEqual(self.job['env']['CONFIRM_PROJECT_REF'], '${{ inputs.confirm_project_ref }}')

    def test_environment_gate(self):
        self.assertEqual(self.job['environment'], 'backup-production')
        self.assertEqual(self.job['env']['BACKUP_ENVIRONMENT_GUARD'], '${{ vars.BACKUP_ENVIRONMENT_GUARD }}')
        self.assertNotIn('BACKUP_GUARD_ALLOW_SCHEDULE', self.text)

    def test_concurrency_and_least_privilege(self):
        self.assertEqual(self.wf['concurrency'], {'group': 'db-backup', 'cancel-in-progress': False})
        self.assertEqual(self.wf['permissions'], {'contents': 'read'})
        self.assertNotIn('permissions', self.job)
        self.assertEqual(list(self.wf['jobs'].keys()), ['backup'])

    def test_guard_runs_before_anything_touches_the_database(self):
        steps = self.job['steps']
        runs = [(i, s.get('run', '')) for i, s in enumerate(steps)]
        guard = [i for i, r in runs if 'scripts/ops/backup-guard.sh' in r]
        self.assertEqual(len(guard), 1)
        db = [i for i, r in runs if re.search(r'db-backup\.sh|pg_dump|psql', r)]
        self.assertTrue(db and min(db) > guard[0])
        self.assertTrue(all('uses' in steps[i] and 'checkout' in steps[i]['uses'] for i in range(guard[0])))
        self.assertIs(steps[0]['with']['persist-credentials'], False)

    def test_encryption_and_upload(self):
        self.assertNotIn('BACKUP_ALLOW_PLAINTEXT', self.text)
        self.assertNotIn('BACKUP_STORAGE_FILES', self.text)  # Storage 文件从不 skip
        steps = self.job['steps']
        gate = next(i for i, s in enumerate(steps) if 'assert-encrypted.sh backup' in s.get('run', ''))
        up = next(i for i, s in enumerate(steps) if 'upload-artifact' in s.get('uses', ''))
        self.assertLess(gate, up)
        self.assertEqual(steps[up]['with']['path'], 'backup/*.gpg')
        self.assertGreaterEqual(int(steps[up]['with']['retention-days']), 30)
        self.assertEqual(steps[up]['with']['if-no-files-found'], 'error')

    def test_secrets_only_from_environment_never_echoed(self):
        for line in self.text.splitlines():
            if 'secrets.' in line:
                self.assertNotRegex(line, r'echo|run:')


class DisabledByDefault(unittest.TestCase):
    def test_no_backup_schedules_in_active_workflows(self):
        for p in WF.glob('*.y*ml'):
            if re.search(r'backup', p.name):
                self.assertNotIn('schedule', load(p)['on'], p.name)

    def test_monitor_daily_offsite_live_only_in_disabled_dir(self):
        for name in ('backup-monitor.yml', 'db-backup-daily.yml', 'backup-offsite.yml'):
            self.assertFalse((WF / name).exists(), f'{name} 不应在 .github/workflows/')
            self.assertTrue((DISABLED / name).exists(), f'{name} 应在 ops/disabled-workflows/')
            self.assertIn('默认不启用', (DISABLED / name).read_text(encoding='utf-8'))

    def test_daily_template_keeps_the_same_gate(self):
        d = load(DISABLED / 'db-backup-daily.yml')
        job = d['jobs']['backup']
        self.assertEqual(job['environment'], 'backup-production')
        self.assertEqual(d['on']['schedule'][0]['cron'], '30 19 * * *')
        manual = load(WF / 'db-backup.yml')['jobs']['backup']['steps']
        self.assertEqual([s.get('run') or s.get('uses') for s in job['steps']], [s.get('run') or s.get('uses') for s in manual])


if __name__ == '__main__':
    unittest.main()
