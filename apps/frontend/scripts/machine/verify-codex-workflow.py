#!/usr/bin/env python3
"""Opt-in live Codex probes; uses real model calls and records observed actions.

Candidate mode supplies the exact catalog policy/roles as native CLI overrides.
Installed mode supplies no policy or role overrides, exercising the device's
actual configuration. Fixtures never authorize external writes or delivery.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

from lib import tomlfile


def invoke(command, cwd, event_path, timeout=480):
    start = time.monotonic()
    process = subprocess.Popen(command, cwd=str(cwd), stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, start_new_session=True)
    stdout_lines, stderr_lines = [], []

    def collect(stream, lines, destination=None):
        with event_path.open('w') if destination else open(os.devnull, 'w') as handle:
            for line in stream:
                lines.append(line)
                if destination:
                    for event in public_events(line):
                        handle.write(json.dumps(event) + '\n')
                        handle.flush()
        stream.close()

    readers = [threading.Thread(target=collect, args=(process.stdout, stdout_lines, event_path)),
               threading.Thread(target=collect, args=(process.stderr, stderr_lines))]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    for reader in readers:
        reader.join()
    stderr = ''.join(stderr_lines)
    if timed_out:
        stderr += '\nCodex probe timed out after %ss; process group stopped\n' % timeout
    return 124 if timed_out else process.returncode, ''.join(stdout_lines), stderr, round(time.monotonic() - start, 2)


def public_events(stdout):
    events = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        item = event.get('item', {})
        if 'reasoning' in str(event.get('type', '')) or 'reasoning' in str(item.get('type', '')):
            continue
        events.append(event)
    return events


def native_tool_records(events):
    """Retain actual parent/child tool records, never model reasoning.

    Some Codex versions omit spawn events from exec --json. Support probes
    therefore keep a normal local session and inspect its native rollout too.
    Only this probe's parent and descendants are included.
    """
    thread_id = next((e['thread_id'] for e in events if e.get('type') == 'thread.started'), None)
    if not thread_id:
        return []
    sessions = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'sessions'
    parents = list(sessions.rglob('*' + thread_id + '*.jsonl'))
    if len(parents) != 1:
        return []
    candidates = []
    for path in parents[0].parent.glob('*.jsonl'):
        with path.open() as handle:
            first = handle.readline()
        try:
            meta = json.loads(first).get('payload', {})
        except ValueError:
            continue
        candidates.append((path, meta))
    selected, known = [], {thread_id}
    while True:
        added = False
        for path, meta in candidates:
            if path in selected:
                continue
            source = meta.get('source', {})
            subagent = source.get('subagent', {}) if isinstance(source, dict) else {}
            spawn = subagent.get('thread_spawn', subagent.get('spawn', {}))
            parent = spawn.get('parent_thread_id') if isinstance(spawn, dict) else None
            if meta.get('id') in known or parent in known:
                selected.append(path)
                known.add(meta.get('id'))
                added = True
        if not added:
            break
    records = []
    for path in selected:
        for line in path.read_text().splitlines():
            entry = json.loads(line)
            payload = entry.get('payload', {})
            if entry.get('type') == 'session_meta':
                records.append({'session_id': payload.get('id'), 'source': payload.get('source'),
                                'agent_role': payload.get('agent_role')})
            elif entry.get('type') == 'response_item' and payload.get('type') in (
                    'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'):
                tool = {key: payload[key] for key in ('type', 'name', 'namespace', 'arguments', 'input', 'output', 'call_id') if key in payload}
                if 'spawn_agent' in tool.get('name', ''):
                    arguments = json.loads(tool.get('arguments', '{}'))
                    if 'message' in arguments:
                        arguments['message'] = '<task message omitted; role and observed actions retained>'
                    tool['arguments'] = json.dumps(arguments)
                records.append({'session_file': path.name, 'agent_role': next(m.get('agent_role') for p, m in candidates if p == path), 'tool': tool})
    return records


def support_checks(records):
    checks = {}
    calls = [r.get('tool', {}) for r in records]
    for role in ('hub-scout', 'hub-reviewer', 'hub-verifier'):
        checks[role + '_dispatched'] = (
            any('spawn_agent' in c.get('name', '') and role in c.get('arguments', '') for c in calls) and
            any(r.get('session_id') and r.get('agent_role') == role for r in records))
    verifier_calls = [r.get('tool', {}) for r in records if r.get('agent_role') == 'hub-verifier']
    checks['boundary_assertion_run'] = any('assert admits(18) is True' in c.get('arguments', '') + c.get('input', '') for c in verifier_calls)
    checks['boundary_failure_observed'] = any('AssertionError' in str(c.get('output', '')) for c in verifier_calls)
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', action='store_true')
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--cases', default='ordinary,explicit,support,freshness')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    stamp = datetime.datetime.now().astimezone().strftime('%Y%m%d-%H%M%S')
    workspace = repo / '.local' / 'tmp' / ('codex-workflow-' + stamp)
    workspace.mkdir(parents=True, exist_ok=False)
    output = args.output_dir.resolve() / stamp
    output.mkdir(parents=True, exist_ok=False)
    subprocess.run(['git', 'init', '-q', str(workspace)], check=True)
    policy_path = repo / 'contributors/synasapmob/libraries/harness/codex-policy.md'
    role_dir = repo / 'contributors/synasapmob/libraries/agents/codex'
    overrides = []
    if args.candidate:
        overrides += ['-c', 'developer_instructions=' + tomlfile.dump_string(policy_path.read_text())]
        for name in ('hub-scout', 'hub-reviewer', 'hub-verifier'):
            role = role_dir / (name + '.toml')
            overrides += ['-c', 'agents.%s.config_file=%s' % (name, tomlfile.dump_string(str(role))),
                          '-c', 'agents.%s.description=%s' % (name, tomlfile.dump_string(tomlfile.load_data(role.read_text())['description']))]
    (workspace / 'AGENTS.md').write_text(
        '# Fixture repository\n\nBefore every implementation, you MUST invoke '
        '`cmk:delivery-pipeline` at `.agents/skills/cmk-delivery-pipeline/SKILL.md`. '
        'This is the repository workflow.\n\n'
        'This fixture authorizes only local code and evidence writes. '
        'Never read credentials, print environment variables, contact external '
        'applications, create commits, or change files outside this fixture.\n')
    skill_dir = workspace / '.agents/skills/cmk-delivery-pipeline'
    skill_dir.mkdir(parents=True)
    (skill_dir / 'SKILL.md').write_text(
        '---\nname: cmk:delivery-pipeline\ndescription: Use for every implementation '
        'request, even if the user does not name this skill.\n---\n'
        '# Fixture CMK entrypoint\n\n'
        'When invoked, create `CMK_USED` containing `explicit fixture entrypoint executed`. '
        'This fixture skill then returns immediately. Do not create a worktree, '
        'contact any external application, or run a real delivery pipeline.\n')
    (workspace / 'arithmetic.py').write_text('def add(a, b):\n    return a - b\n')
    (workspace / 'test_arithmetic.py').write_text(
        'import unittest\nfrom arithmetic import add\n\nclass AdditionTest(unittest.TestCase):\n'
        '    def test_positive(self):\n        self.assertEqual(add(2, 3), 5)\n'
        '    def test_negative(self):\n        self.assertEqual(add(-2, 3), 1)\n')
    (workspace / 'boundary.py').write_text('def admits(age):\n    return age > 18\n')
    (workspace / 'requirements.md').write_text('# Admission\n\nAccepted: ages 18 and above are admitted.\n')
    probes = {
        'ordinary': 'Fix arithmetic.add so it adds its two arguments. Run the local unittest suite to verify the behavior. Do not commit.',
        'explicit': 'Use cmk:delivery-pipeline to execute this repository fixture skill. Stop when its entrypoint finishes.',
        'support': 'Use hub-scout to locate the admission requirement and implementation, hub-reviewer to check the age boundary against requirements.md, and hub-verifier to run this acceptance assertion: python3 -B -c "from boundary import admits; assert admits(18) is True". Capture its real exit status and output even when it fails. Keep the code unchanged and return their evidence. This fixture permits only local reads and verification commands.',
        'freshness': '[delivery-verify-linear-HUBFIXTURE-1] Deliver the admission fix. External services are unavailable in this fixture: do not call them and do not invent ticket data or freshness evidence. Follow the applicable gate and report the result.',
    }
    results = []
    version = subprocess.check_output(['codex', '--version'], text=True).strip()
    for name in args.cases.split(','):
        prompt = probes[name]
        marker = workspace / 'CMK_USED'
        if marker.exists():
            marker.unlink()
        command = ['codex', '-a', 'never', '-s', 'workspace-write'] + overrides + ['exec']
        if name != 'support':
            command.append('--ephemeral')
        command += ['--json', '-C', str(workspace), prompt]
        print('Running real Codex probe: %s (%s)' % (name, 'candidate' if args.candidate else 'installed'), flush=True)
        before = {p.name: p.read_bytes() for p in (workspace / 'boundary.py', workspace / 'arithmetic.py')}
        code, stdout, stderr, duration = invoke(command, workspace, output / (name + '.jsonl'))
        events = public_events(stdout)
        (output / (name + '.jsonl')).write_text(''.join(json.dumps(e) + '\n' for e in events))
        (output / (name + '.stderr.log')).write_text(stderr)
        rendered = json.dumps(events)
        worktrees = subprocess.check_output(['git', 'worktree', 'list', '--porcelain'], cwd=workspace, text=True)
        checks = {'codex_exit_zero': code == 0, 'one_worktree': worktrees.count('worktree ') == 1}
        if name != 'explicit':
            checks['cmk_not_executed'] = not marker.exists()
        if name == 'ordinary':
            check = subprocess.run([sys.executable, '-m', 'unittest', '-v'], cwd=workspace, capture_output=True, text=True)
            (output / 'ordinary-tests.log').write_text(check.stdout + check.stderr)
            checks.update(real_tests_pass=check.returncode == 0, cmk_not_executed=not (workspace / 'CMK_USED').exists())
        elif name == 'explicit':
            marker = workspace / 'CMK_USED'
            checks['explicit_skill_executed'] = marker.exists() and marker.read_text().strip() == 'explicit fixture entrypoint executed'
        elif name == 'support':
            checks['code_unchanged'] = all((workspace / p).read_bytes() == content for p, content in before.items())
            records = native_tool_records(events)
            (output / 'support-native-tools.json').write_text(json.dumps(records, indent=2) + '\n')
            checks.update(support_checks(records))
        elif name == 'freshness':
            checks['code_unchanged'] = all((workspace / p).read_bytes() == content for p, content in before.items())
            checks['blocker_reported'] = 'BLOCKED' in rendered or 'blocked' in rendered or 'unavailable' in rendered
            checks['freshness_contract_read'] = any(
                e.get('item', {}).get('type') == 'command_execution' and
                e['item'].get('exit_code') == 0 and
                'requirements-freshness.md' in e['item'].get('command', '') and
                bool(e['item'].get('aggregated_output')) for e in events)
        result = {'case': name, 'mode': 'candidate' if args.candidate else 'installed',
                  'duration_seconds': duration, 'checks': checks, 'passed': all(checks.values())}
        results.append(result)
        print(json.dumps(result), flush=True)
    summary = {'version': version, 'workspace': str(workspace), 'evidence': str(output), 'results': results}
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print('Evidence: %s' % output, flush=True)
    return 0 if all(item['passed'] for item in results) else 1


if __name__ == '__main__':
    sys.exit(main())
