import { execFileSync } from 'node:child_process';

const root = process.cwd();
const branch = String(process.env.STAR_OWNER_DEFAULT_BRANCH || process.env.GITHUB_REF_NAME || 'main');
const repository = String(process.env.GITHUB_REPOSITORY || '');
const token = String(process.env.GITHUB_TOKEN || '');
const apiBase = String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const context = 'validate-shared-docs';
const runId = String(process.env.GITHUB_RUN_ID || Date.now()).replace(/[^a-zA-Z0-9-]/g, '-');
const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT || '1').replace(/[^a-zA-Z0-9-]/g, '-');
const runUrl = process.env.GITHUB_SERVER_URL && repository && process.env.GITHUB_RUN_ID
  ? String(process.env.GITHUB_SERVER_URL) + '/' + repository + '/actions/runs/' + process.env.GITHUB_RUN_ID
  : '';

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe'
  });
}

async function reportValidatedCommit(sha) {
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY 或 GITHUB_TOKEN 未设置，无法报告目录提交校验状态。');
  const payload = {
    state: 'success',
    context,
    description: '共享文档目录提交已通过完整校验。'
  };
  if (runUrl) payload.target_url = runUrl;
  const response = await fetch(apiBase + '/repos/' + repository + '/statuses/' + sha, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error('GitHub 返回状态 ' + response.status + '：' + responseText.slice(0, 300));
}

async function main() {
  if (!repository || !token) throw new Error('共享目录发布缺少 GitHub Actions 身份信息。');
  git(['config', 'user.name', 'star-owner-catalog[bot]']);
  git(['config', 'user.email', 'star-owner-catalog[bot]@users.noreply.github.com']);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const temporaryBranch = 'star-owner-catalog/' + runId + '-' + runAttempt + '-' + attempt;
    let temporaryBranchPushed = false;
    try {
      git(['fetch', '--no-tags', 'origin', branch]);
      git(['reset', '--hard', 'origin/' + branch], { stdio: 'inherit' });
      execFileSync(process.execPath, ['scripts/validate-shared-docs.mjs'], { cwd: root, stdio: 'inherit' });
      execFileSync(process.execPath, ['scripts/build-catalog.mjs'], { cwd: root, stdio: 'inherit' });
      if (!git(['status', '--porcelain', '--', 'catalog.json']).trim()) {
        console.log('catalog.json is already current');
        return;
      }

      git(['add', '--', 'catalog.json']);
      git(['commit', '-m', 'chore: rebuild shared catalog'], { stdio: 'inherit' });
      // Validate the exact commit that will be promoted, not only its parent.
      execFileSync(process.execPath, ['scripts/validate-shared-docs.mjs'], { cwd: root, stdio: 'inherit' });
      const sha = git(['rev-parse', 'HEAD']).trim();

      // A protected main branch rejects an unverified new commit. Make the
      // commit reachable first, then attach the same validated status to it.
      git(['push', 'origin', sha + ':refs/heads/' + temporaryBranch], { stdio: 'inherit' });
      temporaryBranchPushed = true;
      await reportValidatedCommit(sha);

      git(['fetch', '--no-tags', 'origin', branch]);
      const currentMain = git(['rev-parse', 'origin/' + branch]).trim();
      const catalogParent = git(['rev-parse', sha + '^']).trim();
      if (currentMain !== catalogParent) {
        console.log('main changed while catalog was being prepared; retrying');
        continue;
      }

      git(['push', 'origin', sha + ':refs/heads/' + branch], { stdio: 'inherit' });
      console.log('shared catalog committed to protected ' + branch + ' (' + sha + ')');
      return;
    } catch (error) {
      console.error('catalog publish attempt ' + attempt + ' failed: ' + (error.message || String(error)));
    } finally {
      if (temporaryBranchPushed) {
        try { git(['push', 'origin', '--delete', temporaryBranch], { stdio: 'inherit' }); } catch {}
      }
    }
  }
  throw new Error('catalog publish failed after retries');
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
