// REQ-M16: command words that reach the shell through ANSI-C or locale
// quoting, or through expansion, must never be classified as harmless.
// Rows marked "run" are also executed by real bash with PATH stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLASSIFIER = path.join(ROOT, 'hooks/universal/pre-tool/graph-command-classifier.mjs');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
const env = { ...process.env, LC_ALL: 'C.UTF-8' };
for (const key of Object.keys(env)) if (key.startsWith('GIT_') || key.startsWith('BASH_FUNC_') || ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'DEVOPS_GRAPH_CYCLE_ID'].includes(key)) delete env[key];

const source = readFileSync(CLASSIFIER, 'utf8');
const start = source.indexOf('function tokenize(text) {');
const end = source.indexOf('// Program position is ONE computed thing', start);
assert.ok(start >= 0 && end > start, 'locate the production tokenizer');
const tokenize = runInNewContext('const MAX_TEXT = 64 * 1024;\n' + source.slice(start, end) + '\ntokenize;');

const V = ['ver', 'cel'].join('');
const D = ' deploy --prod';
const sealedMutation = (args) => args.includes('update-ref') || args.includes('-D') || args.includes('--delete') || (args.includes('tag') && args.includes('-d'));
const deployed = (name, args) => name === 'vercel' && args.includes('deploy') || name === 'npm' && args.includes('publish') || name === 'git' && args.includes('push');

// Round 5 rows. Each one executes (or is refused by real git) while the round-4
// classifier allowed it; see the real-git and real-filesystem tests below.
const R5_ALIAS_DEPLOY = [
  `git -c alias.p=push p origin main`, `git -c alias.p=push p origin v0.2.0`, `git -calias.p=push p origin main`, `git -c Alias.p=push p origin main`,
  `git -c alias.p='!${V}${D}' p`, `git -c alias.p='!git push origin main' p`, `git -c "$CFG" push origin main`, `git --config-env=alias.p=A p`, `git --config-env alias.p=A p`,
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin main`, `GIT_CONFIG_PARAMETERS="'alias.p=push'" git p origin main`,
  `env GIT_CONFIG_COUNT=1 git p origin main`, `export GIT_CONFIG_COUNT=1; git p origin main`, `GIT_CONFIG_GLOBAL=x git p origin main`,
  `caffeinate git -c alias.p=push p origin main`, `echo p | xargs git -c alias.p=push`,
];
const R5_NPM_DEPLOY = [
  `npm exec -- ${V}${D}`, `npm exec ${V} -- deploy --prod`, `npm x -- ${V}${D}`, `npm exec --call '${V}${D}'`, `npm exec -c '${V}${D}'`, `npm exec --call='${V}${D}'`,
  `npm exec --yes -- ${V}${D}`, `npm exec -y -- ${V}${D}`, `npm exec --no -- ${V}${D}`, `npm exec -p ${V} -- ${V}${D}`, `npm exec ${V}@latest -- deploy --prod`,
  `npm --prefix . exec -- ${V}${D}`, `npm -w a exec -c '${V}${D}'`, `npm --silent x -- ${V}${D}`, `npm --prefix . publish`, `npm --weird exec -- ${V}${D}`,
  `npm exec -c "$X"`, `npm exec --bogus -- ${V}${D}`, `NPM x -- ${V}${D}`, `sudo npm exec -c '${V}${D}'`, `caffeinate npm exec -- ${V}${D}`, `npx ${V}@latest${D}`,
];
const R5_NPM_SEALED = [
  `npm exec -- git tag -d v0.2.0`, `npm x -- git update-ref refs/tags/v0.2.0 HEAD`, `npm exec --call 'git tag -d v0.2.0'`, `npm exec -c 'git branch -D stratum-merge'`,
  `npm --prefix . exec -c 'git tag -d v0.2.0'`, `npm exec -c "$X"`, `npm exec --bogus -- git tag -d v0.2.0`,
];
// Loose-ref spellings that APFS resolves case-insensitively (real git mutates them there).
const R5_CASE = [
  `git tag -d V0.2.0`, `git update-ref -d refs/tags/V0.2.0`, `git branch -D Stratum-Merge`, `git update-ref refs/tags/V0.2.0 HEAD~0`, `git tag -f V0.2.0 HEAD~0`,
  `git branch -f Stratum-Merge HEAD~0`,
];
// Writers into .git that no allowlist can enumerate, and the spellings that reach it.
// [command, program the machine needs]
const R5_GIT_WRITES = [
  [`tar -cf .git/packed-refs x`, 'tar'], [`curl -s -o .git/packed-refs file:///dev/null`, 'curl'], [`curl -s -o.git/packed-refs file:///dev/null`, 'curl'],
  [`sqlite3 :memory: '.output .git/packed-refs' 'select 1'`, 'sqlite3'], [`rsync x .git/packed-refs`, 'rsync'], [`ditto x .git/packed-refs`, 'ditto'],
  [`cp x .git/packed-refs`, 'cp'], [`dd if=x of=.git/packed-refs`, 'dd'], [`sort -o .git/packed-refs x`, 'sort'], [`uniq x .git/packed-refs`, 'uniq'],
  [`rm -f $PWD/.git/packed-refs`, 'rm'], [`rm -f "$PWD"/.git/packed-refs`, 'rm'], [`rm -f "$(pwd)"/.git/packed-refs`, 'rm'], [`rm -f \${PWD}/.git/packed-refs`, 'rm'],
  [`rm -f .gi?/packed-refs`, 'rm'], [`rm -f .[g]it/packed-refs`, 'rm'], [`rm -f .g*/packed-refs`, 'rm'], [`rm -rf .[g]it`, 'rm'], [`rm -rf .*`, 'rm'],
  [`rm -rf "$(pwd)"`, 'rm'], [`rm -rf $PWD`, 'rm'],
  [`cd .git && rm packed-refs`, 'rm'], [`cd .git; rm packed-refs`, 'rm'], [`cd ./.git/ && rm packed-refs`, 'rm'], [`cd .git && tar -cf packed-refs ../x`, 'tar'],
  [`cd .git && cd refs && rm ../packed-refs`, 'rm'], [`pushd .git; rm packed-refs`, 'rm'],
  [`find .git -name packed-refs -delete`, 'find'], [`find .git -name packed-refs -exec rm -- '{}' +`, 'find'], [`find .git -name packed-refs -execdir rm '{}' \\;`, 'find'],
  [`find .git -name packed-refs -exec sh -c 'rm "$0"' '{}' \\;`, 'find'],
  [`find . -path './.git/*' -name packed-refs -delete`, 'find'], [`find $PWD/.git -name packed-refs -delete`, 'find'],
  [`echo .git/packed-refs | xargs rm`, 'xargs'], [`echo .git/packed-refs | xargs rm -f`, 'xargs'], [`echo .git/packed-refs | xargs -n1 rm`, 'xargs'],
  [`echo .git/packed-refs | xargs env rm`, 'xargs'], [`printf '.git/packed-refs\\0' | xargs -0 rm`, 'xargs'],
  [`python3 -c 'import os; os.remove(".git/packed-refs")'`, 'python3'], [`node -e 'require("fs").unlinkSync(".git/packed-refs")'`, 'node'],
  [`perl -e 'unlink ".git/packed-refs"'`, 'perl'], [`ruby -e 'File.delete(".git/packed-refs")'`, 'ruby'],
  [`bash -c 'rm "$@"' _ .git/packed-refs`, 'bash'],
];
// Spellings that only reach .git on a case-insensitive filesystem (APFS).
const R5_GIT_WRITES_CASE = [[`rm -f .GIT/packed-refs`, 'rm'], [`cd .GIT && rm packed-refs`, 'rm'], [`find .Git -name packed-refs -delete`, 'find'], [`tar -cf .GIT/packed-refs x`, 'tar']];
const R5_DEPLOY = [...R5_ALIAS_DEPLOY, ...R5_NPM_DEPLOY];
const R5_SEALED = [
  ...R5_NPM_SEALED, ...R5_CASE, ...R5_ALIAS_DEPLOY, `git -c alias.d='tag -d' d v0.2.0`,
  ...[...R5_GIT_WRITES, ...R5_GIT_WRITES_CASE].map(([c]) => c),
  // Classifier only: git refuses an upper-case refs/ prefix, and sudo prompts.
  `find .git -name packed-refs -ok rm '{}' \\;`, `find .git -name packed-refs -okdir rm '{}' \\;`, `git update-ref -d REFS/TAGS/V0.2.0`, `cd .git; sudo -n rm packed-refs`, `sudo -n rm .git/packed-refs`,
  `bash .git/hooks/x`, `sh -c 'echo' _ .git/x`, `source .git/x`, `. .git/x`, `parallel rm ::: .git/packed-refs`, `su -c 'rm .git/packed-refs'`,
  `awk 'BEGIN{print "x" > ".git/HEAD"}'`, `awk -i inplace 1 .git/packed-refs`, `gawk -i inplace 1 .git/packed-refs`, `sed -i s/a/b/ .git/packed-refs`, `sed -ni p .git/packed-refs`,
  `tee .git/HEAD`, `echo x | tee -a .git/HEAD`, `less -O .git/x y`, `sort --output=.git/x y`, `install x .git/packed-refs`, `mkdir .git/refs/tags/new`, `touch .git/refs/tags/v9`,
  `xargs git -c alias.d='tag -d' d`, `echo .git/x | xargs sed -i s/a/b/`, `echo .git/x | xargs touch`, `echo .git/packed-refs | xargs mv -f`, `echo .git/x | xargs sudo rm`, `echo x | xargs -I% rm %`,
];

// [command, runInBash]
const DEPLOY_BYPASS = [
  [`$'${V}'${D}`, true], [`$'\\x76ercel'${D}`, true], [`$'\\166ercel'${D}`, true],
  [`v$'er'cel${D}`, true], [`$'ver'$'cel'${D}`, true], [`$'ver'"cel"${D}`, true], [`'ver'$'cel'${D}`, true], [`""$'${V}'${D}`, true],
  [`$'${V}\\0junk'${D}`, true], [`$'\\u0076ercel'${D}`, false], [`$"${V}"${D}`, true],
  [`X=1 $'${V}'${D}`, true], [`env $'${V}'${D}`, true], [`command $'${V}'${D}`, true], [`nohup $'${V}'${D}`, true],
  [`$'sudo' ${V}${D}`, true], [`$'env' ${V}${D}`, true], [`$'bash' -c '${V}${D}'`, true], [`$'eval' '${V}${D}'`, true],
  [`VAR=${V}; $VAR${D}`, true], [`VAR=${V}; "$VAR"${D}`, true], [`VAR=${V}; \${VAR}${D}`, true], [`VAR='${V}${D}'; $VAR`, true],
  [`$(echo ${V})${D}`, true], [`"$(echo ${V})"${D}`, true], ['`echo ' + V + '`' + D, true],
  [`$((1)) ; ${V}${D}`, true],
  [`[v]ercel${D}`, true], [`v?rcel${D}`, true],
  [`VAR=${V}; sudo $VAR${D}`, true], [`VAR=${V}; echo $VAR | xargs${D}`.replace('xargs', `xargs $VAR`).replace('echo $VAR | ', ''), true],
  [`VAR=${V}; eval $VAR${D}`, true], [`VAR=${V}; eval "$VAR${D}"`, true],
  [`eval "$(printf '%s' dmVyY2Vs | base64 -d)${D}"`, true],
  [`VAR=${V}; bash -c "$VAR${D}"`, true], [`bash -c "$(echo ${V})${D}"`, true],
  // The script is the first non-option word after -c, not the word right after it.
  [`bash -c -- '${V}${D}'`, true], [`bash -c -e '${V}${D}'`, true], [`bash -c -o pipefail '${V}${D}'`, true],
  [`bash -c -O extglob '${V}${D}'`, true], [`bash -c +e '${V}${D}'`, true], [`$'bash' -c -- '${V}${D}'`, true],
  [`sh -c -- '${V}${D}'`, true], [`zsh -c -- '${V}${D}'`, true], [`timeout 5 bash -c -- '${V}${D}'`, true],
  // A replace string moves the program word into stdin data.
  [`echo ${V} | /usr/bin/xargs -J% % deploy --prod`, true], [`echo '${V}${D}' | /usr/bin/xargs -I% sh -c %`, true],
  [`echo ${V} | xargs -I% % deploy --prod`, false], [`echo ${V} | xargs --replace=% % deploy --prod`, false],
  [`echo ${V} | xargs -i % deploy --prod`, false],
  // The -c word itself can end in an operand-taking letter.
  [`bash -co pipefail '${V}${D}'`, true], [`bash -cO extglob '${V}${D}'`, true], [`bash -eco pipefail '${V}${D}'`, true],
  [`zsh -co pipefail '${V}${D}'`, true], [`sh -co pipefail '${V}${D}'`, true],
  // Flags combined with the replace flag.
  [`printf '${V}\\0' | /usr/bin/xargs -0J% % deploy --prod`, true], [`echo ${V} | /usr/bin/xargs -tJ% % deploy --prod`, true],
  [`printf '${V}${D}\\0' | /usr/bin/xargs -0I% sh -c %`, true],
  // xargs appends stdin data to the program's arguments.
  [`echo publish | /usr/bin/xargs npm`, false], [`echo 'release create v1' | /usr/bin/xargs gh`, false], [`echo 'db push' | /usr/bin/xargs supabase`, false],
  [`echo deploy | /usr/bin/xargs ${V}`, true],
  // Shells outside the common set, and shells that read their script from stdin.
  [`tcsh -c '${V}${D}'`, true], [`csh -c '${V}${D}'`, true], [`/bin/tcsh -c '${V}${D}'`, true],
  [`echo '${V}${D}' | bash`, true], [`echo '${V}${D}' | sh`, true], [`echo '${V}${D}' | zsh`, true], [`echo '${V}${D}' | ksh`, true],
  [`echo '${V}${D}' | dash`, true], [`echo '${V}${D}' | bash -s`, true], [`echo '${V}${D}' | bash -`, true],
  [`echo '${V}${D}' | bash -s -- a b`, true], [`echo '${V}${D}' | bash -e`, true], [`echo '${V}${D}' | sudo bash`, true],
  // Unknown heads and wrappers at any position.
  [`caffeinate ${V}${D}`, true], [`/usr/bin/time ${V}${D}`, true], [`caffeinate sudo ${V}${D}`, true],
  // sudo/doas shell modes hand a string to a shell.
  [`sudo -s '${V}${D}'`, false], [`sudo -i '${V}${D}'`, false], [`sudo --shell '${V}${D}'`, false],
  [`echo '${V}${D}' | sudo -s`, false], [`echo '${V}${D}' | doas -s`, false], [`doas -s '${V}${D}'`, false],
  // A prefix program in front of the xargs command does not hide it.
  [`echo publish | /usr/bin/xargs env npm`, true], [`echo deploy | /usr/bin/xargs env ${V}`, true], [`echo deploy | /usr/bin/xargs -- env ${V}`, true],
  [`echo deploy | /usr/bin/xargs command ${V}`, true], [`echo deploy | /usr/bin/xargs nice ${V}`, true], [`echo deploy | /usr/bin/xargs caffeinate ${V}`, true],
  [`echo deploy | /usr/bin/xargs sudo ${V}`, true], [`echo deploy | /usr/bin/xargs /usr/bin/env ${V}`, true],
  // A pseudo-file operand is stdin.
  [`echo '${V}${D}' | bash /dev/stdin`, true], [`echo '${V}${D}' | sh /dev/stdin`, true], [`echo '${V}${D}' | bash /dev/fd/0`, true],
  [`echo '${V}${D}' | bash -- /dev/stdin`, true], [`echo '${V}${D}' | bash /proc/self/fd/0`, false],
  [`echo '${V}${D}' | source /dev/stdin`, true], [`echo '${V}${D}' | . /dev/stdin`, true], [`F=/dev/stdin; echo '${V}${D}' | source $F`, true],
  // Unrecognised launchers in front of a shell fed by a pipe.
  [`echo '${V}${D}' | xcrun bash`, true], [`echo '${V}${D}' | arch -arm64 bash`, true],
  [`echo '${V}${D}' | find . -maxdepth 0 -exec bash \\;`, true], [`echo '${V}${D}' | find . -maxdepth 0 -exec sh \\;`, true],
  // A deploy-class push behind a launcher.
  [`caffeinate git push origin v0.2.0`, true], [`/usr/bin/time git push origin v0.2.0`, true], [`caffeinate git push --tags origin`, true],
  [`find . -maxdepth 0 -exec git push origin v0.2.0 \\;`, true],
  // fish takes its script from -c, -C and --command.
  [`fish -c '${V}${D}'`, false], [`fish --command '${V}${D}'`, false], [`fish --command='${V}${D}'`, false], [`fish -C '${V}${D}'`, false],
  [`echo '${V}${D}' | fish`, false], [`echo '${V}${D}' | fish /dev/stdin`, false],
  [`watch -n1 '${V}${D}'`, false], [`su -c '${V}${D}'`, false], [`parallel '${V}${D}' ::: 1`, false],
];
const SEALED_BYPASS = [
  `$'git' update-ref refs/tags/v0.2.0 HEAD`, `$'git' tag -d v0.2.0`, `$'\\x67it' branch -D stratum-merge`,
  `g$'it' push origin --delete phase-2-security-depth`, `G=git; $G tag -d v0.2.0`, `G=git; "$G" update-ref refs/tags/v0.2.0 HEAD`,
  `G=git; \${G} tag -d v0.2.0`, `$(echo git) tag -d v0.2.0`, '`echo git` tag -d v0.2.0', `env $'git' tag -d v0.2.0`,
  `G=git; sudo $G tag -d v0.2.0`, `$'git' -C . update-ref refs/heads/phase-2-security-depth HEAD`,
  `bash -c -- 'git tag -d v0.2.0'`, `sh -c -- 'git update-ref refs/tags/v0.2.0 HEAD'`, `bash -c -e 'git tag -d v0.2.0'`,
  `bash -c -o pipefail 'git tag -d v0.2.0'`, `bash -c -O extglob 'git tag -d v0.2.0'`,
  `bash -co pipefail 'git tag -d v0.2.0'`, `bash -cO extglob 'git tag -d v0.2.0'`, `bash -eco pipefail 'git tag -d v0.2.0'`,
  `zsh -co pipefail 'git tag -d v0.2.0'`, `sh -co pipefail 'git tag -d v0.2.0'`,
  `echo tag -d v0.2.0 | /usr/bin/xargs git`, `echo v0.2.0 | /usr/bin/xargs git tag -d`,
  `tcsh -c 'git tag -d v0.2.0'`, `csh -c 'git tag -d v0.2.0'`, `/bin/tcsh -c 'git tag -d v0.2.0'`,
  `echo 'git tag -d v0.2.0' | sh`, `echo 'git tag -d v0.2.0' | bash -s`, `echo 'git tag -d v0.2.0' | sudo bash`,
  `caffeinate git tag -d v0.2.0`, `/usr/bin/time git tag -d v0.2.0`, `find . -maxdepth 0 -exec git tag -d v0.2.0 \\;`,
  `caffeinate sudo git tag -d v0.2.0`,
  `echo v0.2.0 | /usr/bin/xargs env git tag -d`, `echo v0.2.0 | /usr/bin/xargs -- env git tag -d`, `echo v0.2.0 | /usr/bin/xargs command git tag -d`,
  `echo v0.2.0 | /usr/bin/xargs nice git tag -d`, `echo v0.2.0 | /usr/bin/xargs caffeinate git tag -d`, `echo v0.2.0 | /usr/bin/xargs sudo git tag -d`,
  `echo v0.2.0 | /usr/bin/xargs /usr/bin/env git tag -d`,
  `echo 'git tag -d v0.2.0' | bash /dev/stdin`, `echo 'git tag -d v0.2.0' | sh /dev/stdin`, `echo 'git tag -d v0.2.0' | bash /dev/fd/0`,
  `echo 'git tag -d v0.2.0' | bash -- /dev/stdin`, `echo 'git tag -d v0.2.0' | source /dev/stdin`, `echo 'git tag -d v0.2.0' | . /dev/stdin`,
  `echo 'git tag -d v0.2.0' | xcrun bash`, `echo 'git tag -d v0.2.0' | arch -arm64 bash`,
  `echo 'git tag -d v0.2.0' | find . -maxdepth 0 -exec bash \\;`, `echo 'git tag -d v0.2.0' | find . -maxdepth 0 -exec sh \\;`,
];
// Not executed by bash: the real sudo/doas prompts.
const SEALED_NOT_RUN = [`fish -c 'git tag -d v0.2.0'`, `fish --command='git tag -d v0.2.0'`, `fish -C 'git tag -d v0.2.0'`, `echo 'git tag -d v0.2.0' | fish`, `echo 'git tag -d v0.2.0' | fish /dev/stdin`, `sudo -s 'git tag -d v0.2.0'`, `sudo -i 'git tag -d v0.2.0'`, `doas -s 'git tag -d v0.2.0'`, `echo 'git tag -d v0.2.0' | sudo -s`];
const ALLOWED = [
  `echo $'a\\nb'`, `printf '%s' "$HOME"`, `echo "$(date)"`, 'ls $HOME', `echo $'\\x41'`, `echo $'A'`, `FOO=$'x'`, `: $'a;b'`,
  `echo $'a;${V}${D}'`, `echo $'$(${V}${D})'`, `echo $'a\\'b'`, `echo $'a\\'b)'`, 'git commit -m "$MSG"', 'vercel ls', 'echo "$HOME" | cat',
  'echo git tag -d v0.2.0', 'caffeinate echo git tag -d v0.2.0', 'bash script.sh', 'echo hi | bash script.sh', 'sudo ls', 'caffeinate ls',
  'echo git push origin main', 'cat bash', 'which bash', 'ls | grep sh', 'echo hi | cat bash', 'source ./env.sh', '. ./env.sh', 'fish script.fish', 'fish --version',
  // Round 4: inert text, ordinary programs with expanded arguments and unchanged git forms.
  'echo vercel deploy --prod', 'printf "%s" vercel deploy', 'caffeinate echo vercel deploy --prod', 'echo vercel ls', 'echo wrangler deploy docs',
  'echo x | xargs echo git tag -d v0.2.0', 'echo x | xargs grep sh', 'curl -s $URL', 'ls $HOME', 'caffeinate ls $HOME', 'caffeinate curl -s $URL',
  'git -c commit.gpgsign=false commit -m x', 'git -C . log', 'cat .git/HEAD', 'node -e 1', 'python3 -c 1', 'git fetch --prune', 'git fetch --tags',
  'xcrun --find clang', 'find . -exec ls \\;', 'echo x | xargs', 'caffeinate -i npm test', '/usr/bin/time -l ls', 'echo x | xargs -n1 echo',
  // Round 5: reads and ordinary writes that stay allowed (only .git writers refuse).
  'find . -name "*.orig" -print', 'find .git -name HEAD -print', "find .git -type f -exec cat '{}' +", "find . -name '*.log' -exec rm '{}' +", 'ls -la .git', 'stat .git/HEAD',
  'cd .git && ls', 'cd .git && cat HEAD', 'cd .git; grep x packed-refs', 'cd src && rm foo.txt', 'cd src; rm foo.txt', 'rm foo.txt', 'rm -f build/out.txt', 'rm -rf $TMP/x',
  'rm .github/x', 'cat .github/workflows/ci.yml', 'grep -r foo .git', 'sed -n 1p .git/HEAD', "awk '{print}' .git/HEAD", 'sort .git/packed-refs', 'uniq .git/packed-refs',
  'echo a | xargs echo', 'echo a | xargs wc -l', 'echo a | xargs grep -l b', 'git -c core.pager=cat log', 'git -c user.name=x commit -m x',
  'npm test -- vercel deploy --prod', 'npm run build', 'npm --prefix . test', 'npm install', 'npm exec -- ls', "npm exec -c 'echo hi'", 'npm x -- ls', 'GIT_CONFIG_NOSYSTEM=1 git status', 'echo GIT_CONFIG_COUNT=1',
  'git checkout -b feature', 'git switch -c feature', 'git config user.name x', 'git fetch origin main', 'git replace --list', 'git symbolic-ref HEAD', 'git symbolic-ref --short HEAD', 'sudo ls',
];
const REFUSED = [
  `echo $'\\cA'`, `echo $'\\q'`, `echo $'\\x'`, `echo $'\\xff'`, `echo $'unterminated`, 'echo $"x"', '$(date)', '~/bin/x', '"$CC" -o x',
];


// Round 4: every row of the advisor oracle harnesses that bash executed while the
// round-3 classifier allowed it (harness.mjs, adv-harness.mjs). Rows are executed by
// PATH stubs, so they prove the guarded program runs; the stub cannot prove a ref
// mutation, which the real-git oracle below does.
const R4_DEPLOY = [
  "echo 'vercel deploy --prod' | bash //dev/stdin",
  "echo 'vercel deploy --prod' | bash /dev//stdin",
  "echo 'vercel deploy --prod' | bash /dev/./stdin",
  "echo 'vercel deploy --prod' | bash /./dev/stdin",
  "echo 'vercel deploy --prod' | bash /private/../dev/stdin",
  "echo 'vercel deploy --prod' | source //dev/stdin",
  "X=vercel; caffeinate $X deploy --prod",
  "X=vercel; /usr/bin/time $X deploy --prod",
  "X=vercel; xcrun $X deploy --prod",
  "X=vercel; arch -arm64 $X deploy --prod",
  "X=vercel; find . -maxdepth 0 -exec $X deploy --prod \\;",
  "X=vercel; caffeinate \"$X\" deploy --prod",
  "X=vercel; caffeinate $(echo $X) deploy --prod",
  "X=vercel; caffeinate sudo $X deploy --prod",
  "caffeinate $(echo vercel) deploy --prod",
  "caffeinate v?rcel deploy --prod",
  "VERCEL deploy --prod",
  "Vercel deploy --prod",
  "vErCeL deploy --prod",
  "NPM publish",
  "Git push origin v0.2.0",
  "GIT push --tags origin",
  "echo 'vercel deploy --prod' | find . -maxdepth 0 -exec env bash \\;",
  "echo 'vercel deploy --prod' | find . -maxdepth 0 -exec caffeinate bash \\;",
  "echo 'vercel deploy --prod' | xargs -n3 env",
  "echo 'vercel deploy --prod' | xargs env",
  "echo 'vercel deploy --prod' | xargs caffeinate",
  "echo 'vercel deploy --prod' | xargs nice",
  "echo 'vercel deploy --prod' | xargs command",
  "echo 'vercel deploy --prod' | xargs /usr/bin/env",
  "echo 'vercel deploy --prod' | xargs sudo",
  "echo 'vercel deploy --prod' | xargs -- env",
  "echo 'vercel deploy --prod' | xargs arch -arm64",
  "echo 'vercel deploy --prod' | xargs xcrun",
  "echo 'vercel deploy --prod' | xargs /usr/bin/time",
  "echo 'vercel deploy --prod' | xargs timeout 5",
  "echo publish | xargs NPM",
  "echo deploy | xargs VERCEL",
];
const R4_SEALED = [
  "echo 'git tag -d v0.2.0' | bash //dev/stdin",
  "echo 'git tag -d v0.2.0' | bash /private/../dev/stdin",
  "G=git; caffeinate $G tag -d v0.2.0",
  "G=git; /usr/bin/time $G tag -d v0.2.0",
  "G=git; find . -maxdepth 0 -exec $G tag -d v0.2.0 \\;",
  "caffeinate $(echo git) tag -d v0.2.0",
  "GIT tag -d v0.2.0",
  "Git update-ref refs/tags/v0.2.0 HEAD",
  "gIt branch -D stratum-merge",
  "echo v0.2.0 | xargs GIT tag -d",
  "caffeinate GIT tag -d v0.2.0",
  "echo 'git tag -d v0.2.0' | find . -maxdepth 0 -exec env bash \\;",
  "echo 'git tag -d v0.2.0' | xargs env",
  "echo 'git tag -d v0.2.0' | xargs caffeinate",
  "echo 'git tag -d v0.2.0' | xargs -n4 env",
  "echo 'git tag -d v0.2.0' | source //dev/stdin",
];

const R4_INTERPRETER_DEPLOY = [
  `expect -c 'spawn ${V}${D}; expect eof'`, `perl -e 'exec "${V}","deploy","--prod"'`, `python3 -c 'import os;os.execvp("${V}",["${V}","deploy","--prod"])'`,
  `ruby -e 'exec "${V}","deploy","--prod"'`, `osascript -e 'do shell script "${V}${D}"'`, `awk 'BEGIN{system("${V}${D}")}'`,
];
const R4_INTERPRETER_SEALED = [
  `perl -e 'exec "git","tag","-d","v0.2.0"'`, `python3 -c 'import os;os.execvp("git",["git","tag","-d","v0.2.0"])'`,
];
// Refused by real git (the stub accepts any argv), still blocked by the classifier.
const REFUSED_BY_GIT = [`git update-ref refs/tags//v0.2.0 HEAD`, `git update-ref ./refs/tags/v0.2.0 HEAD`, `git tag -d ./v0.2.0`, `git -calias.d='tag -d' d v0.2.0`];
// Rows the classifier blocks in both modes beyond the executed oracle rows: launcher
// chains, case variants and prefix-only forms that need no harness run.
const R4_BLOCKED_MORE = [
  // Classifier only: bash resolves /dev/fd/.. intermittently (fdesc), so these are never executed.
  `echo '${V}${D}' | bash /dev/fd/../stdin`, `echo '${V}${D}' | . /dev/fd/../stdin`,
  ...R5_DEPLOY,
  `X=${V}; chrt 0 $X${D}`, `X=${V}; taskset 1 $X${D}`, `X=${V}; unbuffer $X${D}`, `X=${V}; script -q /dev/null $X${D}`, `X=${V}; ionice $X${D}`,
  `script -q /dev/null`, `caffeinate -z ${V}${D}`, `/usr/bin/time -x ${V}${D}`, `xcrun --bogus ${V}${D}`, `arch -bogus ${V}${D}`,
  `echo '${V}${D}' | xargs -Z env`, `echo '${V}${D}' | xargs -- /usr/bin/env`, `echo x | xargs -n1 -I{} env {}`,
  `echo '${V}${D}' | bash //dev//stdin`, `echo '${V}${D}' | bash /dev/fd/0/`, `echo '${V}${D}' | bash /dev/fd/00`, `echo '${V}${D}' | bash ../../../dev/stdin`,
  `F=script.sh; bash "$F"`, `echo '${V}${D}' | fish //dev/stdin`,
  `caffeinate ${V.toUpperCase()}${D}`, `/usr/bin/${V.toUpperCase()}${D}`, `sudo -u root ${V.toUpperCase()}${D}`,
  `X=${V}; foo $X${D}`, `X=${V}; $X${D}`, `$(true)env ${V}${D}`,
  `find . -maxdepth 0 -exec ${V.toUpperCase()}${D} \;`, `find . -maxdepth 0 -exec sudo $X ${D} \;`,
  `echo x | xargs -I% ${V}${D}`, `echo x | xargs --replace=% ${V}${D}`, `echo x | xargs -J% ${V}${D}`,
  `chroot / ${V}${D}`, `X=1 chroot $R ${V}${D}`,
];
const R4_SEALED_MORE = [
  `echo 'git tag -d v0.2.0' | bash /dev/fd/../stdin`,
  ...R5_SEALED,
  `git -c alias.d='tag -d' d v0.2.0`, `git -c Alias.d=tag d -d v0.2.0`, `git -c "$CFG" tag -d x`, `git --config-env=alias.d=A d v0.2.0`, `git --config-env alias.d=A d v0.2.0`,
  `GIT_CONFIG_PARAMETERS="'alias.d=tag -d'" git d v0.2.0`, `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.d GIT_CONFIG_VALUE_0='tag -d' git d v0.2.0`,
  `export GIT_CONFIG_COUNT=1; git d v0.2.0`, `env GIT_CONFIG_COUNT=1 git d v0.2.0`, `git config alias.d 'tag -d'`, `git config --global alias.d 'tag -d'`,
  `git symbolic-ref refs/heads/stratum-merge refs/heads/main`, `git symbolic-ref -d refs/heads/stratum-merge`, `git symbolic-ref refs/heads/$X refs/heads/main`,
  `git fetch . +refs/heads/main:refs/heads/stratum-merge`, `git fetch . +HEAD:refs/tags/v0.2.0`, `git fetch . HEAD:stratum-merge`, `git fetch . 'refs/heads/*:refs/heads/*'`, `git fetch origin "$REF"`,
  `git fetch --refmap= origin x`, `git fetch -P`, `git fetch --prune-tags`, `git pull . +HEAD:refs/heads/stratum-merge`,
  `git checkout -B stratum-merge`, `git checkout -fB stratum-merge`, `git checkout -Bstratum-merge`, `git switch -C stratum-merge`, `git switch --force-create stratum-merge`,
  `git worktree add -B stratum-merge ../wt`, `git replace v0.2.0 HEAD`, `git replace -f refs/tags/v0.2.0 HEAD`,
  `git filter-branch -f -- --all`, `git filter-branch -f --msg-filter 'cat' -- --all`, `git filter-repo --force`,
  `git update-ref refs/tags//v0.2.0 HEAD`, `git update-ref ./refs/tags/v0.2.0 HEAD`, `git tag -d ./v0.2.0`, `git tag -d v0.2.0/`,
  `rm -f .git/refs/tags/v0.2.0`, `rm -rf .git`, `mv .git/packed-refs x`, `cp x .git/refs/heads/stratum-merge`, `echo x | tee .git/refs/tags/v0.2.0`,
  `sed -i.bak 's/a/b/' .git/packed-refs`, `touch .git/refs/tags/v9`, `truncate -s 0 .git/packed-refs`, `dd of=.git/HEAD`, `install x .git/HEAD`, `ln -sf x .git/HEAD`,
  `sudo rm .git/packed-refs`, `caffeinate rm .git/packed-refs`, `rm ./.git/../.git/HEAD`, `rm .git/$X`,
];

function setup(realXargs = false) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-expansion-test-')));
  const bin = path.join(dir, 'stub-bin');
  const mark = path.join(dir, 'executed.log');
  mkdirSync(bin);
  writeFileSync(mark, '');
  for (const name of ['vercel', 'git', 'npm']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\000' ${name} "$@" >> "$STUB_MARK"\nprintf '\\001' >> "$STUB_MARK"\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  for (const name of realXargs ? ['sudo'] : ['sudo', 'xargs']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\nwhile [ "\${1#-}" != "$1" ]; do shift; done\nexec "$@"\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const project = path.join(dir, 'project');
  mkdirSync(project);
  writeFileSync(path.join(project, 'vercel'), ''); // target of the glob rows
  mkdirSync(path.join(project, 'src'));
  return { dir, bin, mark, project };
}
function decide(project, mode, command) {
  const out = spawnSync(process.execPath, [CLASSIFIER, mode, command], { cwd: project, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(out.error, undefined);
  return out.status === 0 ? JSON.parse(out.stdout).decision : 'refused';
}
function ran(ctx, command, hit) {
  writeFileSync(ctx.mark, '');
  spawnSync('bash', ['-c', command], { env: { ...env, PATH: `${ctx.bin}:/usr/bin:/bin`, STUB_MARK: ctx.mark }, cwd: ctx.project, encoding: 'utf8', timeout: 10_000, input: '' });
  return readFileSync(ctx.mark, 'utf8').split('\u0001').filter(Boolean).map((r) => r.split('\0').slice(0, -1)).some(([name, ...args]) => hit(name, args));
}

// The bash oracle only proves a row when the machine has every program and path the row
// names. The classifier assertions never consult this: they run for every row everywhere.
const OPTIONAL_PROGRAMS = ['zsh', 'ksh', 'mksh', 'dash', 'csh', 'tcsh', 'fish', 'caffeinate', 'xcrun', 'arch', 'chrt', 'taskset', 'unbuffer', 'ionice', 'osascript', 'expect', 'perl', 'python3', 'ruby', 'awk', 'base64', 'timeout', 'nice', 'sudo', 'doas', 'xargs', 'find'];
const onPath = (ctx, program) => spawnSync('sh', ['-c', `command -v ${program}`], { env: { PATH: `${ctx.bin}:/usr/bin:/bin` } }).status === 0;
// Behaviour that differs between BSD/macOS and GNU/Debian tools: probe it instead of assuming.
const FEATURE_PROBES = [
  [/xargs\s[^|]*-\w*J/, 'xargs -J', 'echo x | xargs -J% echo %'],
  [/\barch\s+-arm64/, 'arch -arm64', 'arch -arm64 true'],
  [/xargs\s.*\bcommand\b/, 'xargs running the command builtin', 'echo x | xargs command true'],
  [/(?:^|[\s|;])sh\s+-\w*o\s+pipefail/, 'sh -o pipefail', 'sh -o pipefail -c true'],
];
function oracleGap(ctx, command) {
  for (const [pattern, name, probe] of FEATURE_PROBES) {
    if (pattern.test(command) && spawnSync('sh', ['-c', probe], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }).status !== 0) return `${name} is not supported`;
  }
  const words = command.split(/[\s'"|;&()`$=]+/).filter(Boolean);
  // The PATH stubs are lower case; an upper-case spelling finds them only on a case-insensitive filesystem.
  if (words.some((word) => /^(vercel|git|npm|xargs|sudo)$/i.test(word) && word !== word.toLowerCase()) && !caseInsensitive(ctx.dir)) return 'the filesystem is case-sensitive';
  for (const word of words) {
    if (OPTIONAL_PROGRAMS.includes(word) && !onPath(ctx, word)) return `${word} is not installed`;
    if (word.startsWith('/') && word.length > 1 && !existsSync(word)) return `${word} does not exist`;
  }
  return null;
}
const gapNote = (gaps) => `oracle not run for ${gaps.length} rows: ${[...new Set(gaps.map((g) => g.slice(g.lastIndexOf('(') + 1, -1)))].join('; ')}`;
// Split rows into those this machine can execute and those it cannot, with the reason.
function partitionOracle(ctx, rows, commandOf = (row) => row) {
  const runnable = [], gaps = [];
  for (const row of rows) { const gap = oracleGap(ctx, commandOf(row)); if (gap) gaps.push(`${commandOf(row)} (${gap})`); else runnable.push(row); }
  return { runnable, gaps };
}

test('ANSI-C and expanded deploy command words are not allowed', () => {
  const ctx = setup();
  try { for (const [command] of DEPLOY_BYPASS) assert.notEqual(decide(ctx.project, 'deploy', command), 'allow', command); }
  finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
test('bash really runs each deploy bypass row', { skip: !hasBash && 'bash not available' }, (t) => {
  const ctx = setup();
  try {
    const { runnable, gaps } = partitionOracle(ctx, DEPLOY_BYPASS.filter(([, run]) => run), ([command]) => command);
    if (gaps.length) t.diagnostic(gapNote(gaps));
    assert.ok(runnable.length > 0, 'no deploy row can run here');
    for (const [command] of runnable) assert.ok(ran(ctx, command, deployed), 'not executed: ' + command);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
test('ANSI-C and expanded git command words are blocked in sealed mode', () => {
  const ctx = setup();
  try { for (const command of [...SEALED_BYPASS, ...SEALED_NOT_RUN]) assert.equal(decide(ctx.project, 'sealed', command), 'block', command); }
  finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
test('bash really runs each sealed bypass row', { skip: !hasBash && 'bash not available' }, (t) => {
  const ctx = setup();
  try {
    const { runnable, gaps } = partitionOracle(ctx, SEALED_BYPASS);
    if (gaps.length) t.diagnostic(gapNote(gaps));
    assert.ok(runnable.length > 0, 'no sealed row can run here');
    for (const command of runnable) assert.ok(ran(ctx, command, (name, args) => name === 'git' && sealedMutation(args)), 'not executed: ' + command);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
test('literal ANSI-C text stays allowed in both modes; undecodable text is refused', () => {
  const ctx = setup();
  try {
    for (const mode of ['deploy', 'sealed']) for (const command of ALLOWED) assert.equal(decide(ctx.project, mode, command), 'allow', mode + ': ' + command);
    for (const mode of ['deploy', 'sealed']) for (const command of REFUSED) assert.notEqual(decide(ctx.project, mode, command), 'allow', mode + ': ' + command);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
test('tokenize decodes ANSI-C words as literal text', () => {
  const word = (text) => tokenize(text)[0].words[0];
  assert.deepEqual({ ...word(`$'ver\\x63el' deploy`), substitutions: [] }, { text: V, dynamic: false, substitutions: [] });
  assert.equal(word(`$'$X'`).dynamic, false);
  assert.equal(word(`$'$X'`).text, '$X');
  assert.equal(tokenize(`echo $'a;b'`).length, 1);
  assert.equal(word(`$'a\\nb'`).text, 'a\nb');
  assert.equal(word(`"$'x'"`).dynamic, true);
  for (const bad of [`$'\\u0041'`, `$'\\x'`, `$'\\xff'`, `$'a\\0b'`, `$'abc`, `$"x"`]) assert.throws(() => tokenize(bad), bad);
});
test('decoder agrees with bash for the supported escapes', { skip: !hasBash && 'bash not available' }, () => {
  const body = ['\\x76', '\\166', '\\x7g', '\\7', '\\n\\t\\a\\b\\e\\f\\r\\v', "\\'", '\\"', '\\\\', '\\?', 'a\\101z', '\\x4a1'];
  for (const text of body) {
    const expected = spawnSync('bash', ['-c', `printf '%s' $'${text}'`], { encoding: 'latin1' }).stdout;
    assert.equal(tokenize(`$'${text}'`)[0].words[0].text, expected, text);
  }
});

const shellMissing = (command) => ['zsh', 'ksh', 'dash'].some((shell) => new RegExp(`\\b${shell}\\b`).test(command) && spawnSync('sh', ['-c', `command -v ${shell}`]).status !== 0);

test('round 4: oracle rows that bash executed are no longer allowed', () => {
  const ctx = setup(true);
  try {
    for (const command of [...R4_DEPLOY, ...R4_INTERPRETER_DEPLOY, ...R4_BLOCKED_MORE]) assert.notEqual(decide(ctx.project, 'deploy', command), 'allow', 'deploy: ' + command);
    for (const command of [...R4_SEALED, ...R4_INTERPRETER_SEALED, ...REFUSED_BY_GIT, ...R4_SEALED_MORE]) assert.equal(decide(ctx.project, 'sealed', command), 'block', 'sealed: ' + command);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});
test('round 4: bash really runs each oracle row', { skip: !hasBash && 'bash not available' }, (t) => {
  const ctx = setup(true);
  try {
    const deploy = partitionOracle(ctx, [...R4_DEPLOY, ...R4_INTERPRETER_DEPLOY.filter((c) => /^(perl|python3|ruby|awk)/.test(c))].filter((c) => !shellMissing(c)));
    const sealed = partitionOracle(ctx, [...R4_SEALED, ...R4_INTERPRETER_SEALED]);
    if (deploy.gaps.length + sealed.gaps.length) t.diagnostic(gapNote([...deploy.gaps, ...sealed.gaps]));
    assert.ok(deploy.runnable.length > 0 && sealed.runnable.length > 0, 'no oracle row can run here');
    for (const command of deploy.runnable) assert.ok(ran(ctx, command, deployed), 'not executed: ' + command);
    for (const command of sealed.runnable) assert.ok(ran(ctx, command, (name, args) => name === 'git' && sealedMutation(args)), 'not executed: ' + command);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

// Real git in a throwaway repository: a classifier-blocked row must really mutate a
// sealed ref (or be refused by git), which the PATH stub cannot prove.
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const MUTATING_GIT = [
  `git -c alias.d='tag -d' d v0.2.0`, `GIT_CONFIG_PARAMETERS="'alias.d=tag -d'" git d v0.2.0`,
  `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.d GIT_CONFIG_VALUE_0='tag -d' git d v0.2.0`, `A='tag -d' git --config-env=alias.d=A d v0.2.0`,
  `git symbolic-ref refs/heads/stratum-merge refs/heads/main`, `git fetch . +refs/heads/main:refs/heads/stratum-merge`, `git fetch . +HEAD:refs/tags/v0.2.0`,
  `git checkout -B stratum-merge`, `git switch -C stratum-merge`, `git worktree add -B stratum-merge ../wt-r4`,
  `git filter-branch -f --msg-filter 'cat; echo x' -- --all`,
  `rm -f .git/refs/tags/v0.2.0`, `echo x | tee .git/refs/tags/v0.2.0`, `sed -i.bak 's/./x/' .git/refs/tags/v0.2.0`,
];
const UNCHANGED_GIT = [`git -calias.d='tag -d' d v0.2.0`, ...REFUSED_BY_GIT.filter((c) => c.startsWith('git update-ref'))];
test('round 4: sealed rows mutate (or are refused by) real git', { skip: !hasGit && 'git not available' }, () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-realgit-test-')));
  const project = path.join(dir, 'project');
  mkdirSync(project);
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', FILTER_BRANCH_SQUELCH_WARNING: '1' };
  const sh = (command) => spawnSync('sh', ['-c', command], { cwd: project, env: gitEnv, encoding: 'utf8', timeout: 30_000 });
  const snapshot = () => sh('git show-ref 2>&1; find .git/refs -type f | sort | while read f; do echo "$f"; cat "$f"; done; cat .git/packed-refs .git/HEAD 2>&1').stdout;
  const fresh = () => {
    sh('rm -rf .git .gitignore wt-r4; rm -rf ../wt-r4');
    const out = sh('git init -q . && git symbolic-ref HEAD refs/heads/main && git commit -q --allow-empty -m one && git tag v0.2.0 && git branch phase-2-security-depth && git branch stratum-merge && git commit -q --allow-empty -m two');
    assert.equal(out.status, 0, out.stderr);
  };
  try {
    // A case variant only reaches the loose ref on a case-insensitive filesystem (APFS).
    // On a case-sensitive filesystem the variant names a different ref: git may create it, but
    // the sealed refs themselves must stay put, so those rows compare the sealed refs alone.
    const insensitive = caseInsensitive(dir);
    const sealedRefs = () => sh('for r in refs/tags/v0.2.0 refs/heads/stratum-merge refs/heads/phase-2-security-depth; do git rev-parse -q --verify $r || echo gone-$r; done').stdout;
    for (const [command, mutates, view] of [...MUTATING_GIT.map((c) => [c, true, snapshot]), ...R5_CASE.map((c) => [c, insensitive, sealedRefs]), ...UNCHANGED_GIT.map((c) => [c, false, snapshot])]) {
      fresh();
      assert.equal(decide(project, 'sealed', command), 'block', command);
      const before = view();
      sh(command);
      assert.equal(view() !== before, mutates, (mutates ? 'real git did not mutate: ' : 'real git mutated: ') + command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function caseInsensitive(dir) {
  writeFileSync(path.join(dir, 'CaseProbe'), '');
  try { return readFileSync(path.join(dir, 'caseprobe')) !== undefined; } catch { return false; }
}

// Round 5: aliases defined for one command run a push or a shell command in deploy mode.
test('round 5: a per-command alias that pushes or deploys is blocked and really runs', { skip: !hasGit && 'git not available' }, () => {
  const ctx = setup(true);
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', PATH: `${ctx.bin}:/usr/bin:/bin`, STUB_MARK: ctx.mark };
  const remote = path.join(ctx.dir, 'origin.git');
  const sh = (command, cwd = ctx.project) => spawnSync('sh', ['-c', command], { cwd, env: gitEnv, encoding: 'utf8', timeout: 30_000 });
  // The stub git only records; use the real one so that aliases resolve.
  writeFileSync(path.join(ctx.bin, 'git'), `#!/bin/sh\nprintf '%s\\000' git "$@" >> "$STUB_MARK"\nprintf '\\001' >> "$STUB_MARK"\nexec /usr/bin/git "$@"\n`);
  try {
    assert.equal(sh(`git init -q --bare ${remote}`).status, 0);
    assert.equal(sh('git init -q -b main . && git commit -q --allow-empty -m one && git tag v0.2.0 && git remote add origin ' + remote).status, 0);
    for (const command of R5_ALIAS_DEPLOY.filter((c) => /origin|vercel/.test(c) && !/\$CFG|xargs|caffeinate|export|GIT_CONFIG_GLOBAL|env |-calias/.test(c))) {
      sh(`git --git-dir=${remote} update-ref -d refs/heads/main; git --git-dir=${remote} update-ref -d refs/tags/v0.2.0`);
      writeFileSync(ctx.mark, '');
      assert.equal(decide(ctx.project, 'deploy', command), 'block', command);
      const ranIt = spawnSync('bash', ['-c', command], { cwd: ctx.project, env: gitEnv, encoding: 'utf8', timeout: 30_000 });
      const pushed = sh(`git --git-dir=${remote} show-ref`).stdout.trim() !== '';
      const deployedNow = readFileSync(ctx.mark, 'utf8').split('\u0001').filter(Boolean).some((r) => r.startsWith('vercel\0'));
      assert.ok(pushed || deployedNow, 'not executed: ' + command + ' ' + ranIt.stderr);
    }
    for (const mode of ['deploy', 'sealed']) assert.equal(decide(ctx.project, mode, 'git -c commit.gpgsign=false commit --allow-empty -m x'), 'allow', mode);
  } finally { rmSync(ctx.dir, { recursive: true, force: true }); }
});

// Round 5: writers into .git that no allowlist can enumerate, run for real.
test('round 5: .git writers are blocked and really change packed-refs', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'graph-gitwrite-test-')));
  const project = path.join(dir, 'project');
  const gitEnv = { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  // The rows are bash commands (pushd is not in dash, the sh of Debian and Ubuntu).
  const sh = (command) => spawnSync(hasBash ? 'bash' : 'sh', ['-c', command], { cwd: project, env: gitEnv, encoding: 'utf8', timeout: 30_000 });
  const have = (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0;
  const state = () => { try { return readFileSync(path.join(project, '.git/packed-refs'), 'utf8'); } catch { return null; } };
  const fresh = () => {
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project);
    writeFileSync(path.join(project, 'x'), 'replacement\n');
    const out = sh('git init -q -b main . && git commit -q --allow-empty -m one && git tag v0.2.0 && git pack-refs --all');
    assert.equal(out.status, 0, out.stderr);
  };
  const insensitive = caseInsensitive(dir);
  try {
    for (const [command, tool] of [...R5_GIT_WRITES, ...(insensitive ? R5_GIT_WRITES_CASE : [])]) {
      if (!have(tool)) continue;
      fresh();
      assert.equal(decide(project, 'sealed', command), 'block', command);
      const before = state();
      assert.ok(before?.includes('v0.2.0'), 'fixture needs packed-refs');
      sh(command);
      assert.notEqual(state(), before, 'did not change packed-refs: ' + command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
