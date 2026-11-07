// A stand-in for the CLI in the tests of lib.mjs: node fake-cli.mjs <ms> [exit code] [stdout]
// Waits <ms>, prints stdout (stdin when stdout is "-") and exits with the code.
const [ms = '0', code = '0', out = ''] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
setTimeout(() => {
  process.stdout.write(out === '-' ? input : out);
  process.exit(Number(code));
}, Number(ms));
