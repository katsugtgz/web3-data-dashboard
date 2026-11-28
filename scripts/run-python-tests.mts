// Runs the web3-radar-task unittest suite with the first Python 3.9+ interpreter it finds.
const VERSION_CHECK = 'import sys; SystemExit(0 if sys.version_info >= (3, 9) else 1)';
const INTERPRETERS: Array<[command: string, prefix: string[]]> = [
  ['python3', []],
  ['py', ['-3']],
  ['python', []],
];

for (const [command, prefix] of INTERPRETERS) {
  const probe = Bun.spawnSync([command, ...prefix, '-c', VERSION_CHECK], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  if (probe.exitCode === 0) {
    console.log(`Python: ${[command, ...prefix].join(' ')}`);
    const suite = Bun.spawnSync(
      [
        command,
        ...prefix,
        '-B',
        '-m',
        'unittest',
        'discover',
        '-s',
        'skills/web3-radar-task/scripts',
        '-p',
        'test_*.py',
        '-v',
      ],
      {
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'ignore',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
      },
    );
    process.exit(suite.exitCode ?? 1);
  }
}

console.error('No Python 3.9+ interpreter found. Tried: python3, py -3, python.');
process.exit(1);
