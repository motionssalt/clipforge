/**
 * Shadow Clone creation — exact port of bot/src/github.js
 * (beginShadowCloneCreation / pollShadowCloneJob / finalizeShadowClone /
 * cancelShadowCloneRun / readCloneCopyStatus / buildCloneCopyWorkflowYaml).
 *
 * The bot split the flow across a webhook + per-minute cron because a
 * Cloudflare Worker cannot wait minutes on GitHub. The Dashboard browser tab
 * has no such limit: beginCloneCreation dispatches the one-time copy workflow
 * and the caller polls pollShadowCloneJob on a timer (js/features/clone.js),
 * finalizing when the run completes. Failure semantics are identical:
 * stall/never-started/deadline guards, cancelShadowCloneRun, loud errors.
 */

import {
  githubRequest, getGitHubIdentity, parseRepo, b64encode, b64decode,
  GitHubError, DEFAULT_BRANCH, SHADOW_CLONE_SOURCE, CLONE_COPY_WORKFLOW,
  CLONE_STATUS_PATH, CLONE_COPY_START_MS, CLONE_COPY_STALL_MS,
  CLONE_COPY_DEADLINE_MS, cancelWorkflowRun
} from './github.js';

const SHADOW_CLONE_EXCLUDES = [
  /^branding\//,
  /^jobs\//,
  /^audio-library\//,
  /keys/i,
  /accounts/i,
  /queue/i
];

function sourcePathAllowed(path) {
  const value = String(path || '');
  return Boolean(value) && !SHADOW_CLONE_EXCLUDES.some((pattern) => pattern.test(value));
}

export function cloneRepositoryName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name.toLowerCase().endsWith('.git')) {
    throw new Error('Shadow Clone repository name may contain letters, numbers, dots, hyphens, and underscores only.');
  }
  return name;
}

/** bug-45 port: pick a free clipforge-clone-<suffix> name automatically. */
export async function autoCloneRepositoryName(credentials, login) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = Math.random().toString(36).slice(2, 8);
    const candidate = `clipforge-clone-${suffix}`;
    try {
      await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(candidate)}`);
      // 200 => taken, try next.
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return candidate;
      throw error;
    }
  }
  throw new Error('Could not find a free repository name automatically. Enter a name yourself instead.');
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

/** bug-63 port: read the one-time copy workflow's status file. */
async function readCloneCopyStatus(credentials, branch) {
  const { owner, name } = parseRepo(credentials.repo);
  try {
    const file = await githubRequest(credentials,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(CLONE_STATUS_PATH)}?ref=${encodeURIComponent(branch)}`);
    if (!file || typeof file.content !== 'string') return null;
    const parsed = JSON.parse(b64decode(file.content));
    if (!parsed || typeof parsed.state !== 'string') return null;
    return {
      state: parsed.state,
      done: Number(parsed.done) || 0,
      total: Number(parsed.total) || 0,
      error: typeof parsed.error === 'string' ? parsed.error.slice(0, 300) : ''
    };
  } catch {
    return null;
  }
}

/** bug-63 port: the one-time copy workflow committed into a new Shadow Clone. */
function buildCloneCopyWorkflowYaml() {
  return `name: Shadow Clone — one-time file copy

on:
  workflow_dispatch:
    inputs:
      source_sha:
        description: "Source commit SHA to copy from (must be an ancestor of motionssalt/clipforge main)"
        required: true
        type: string
      bootstrap_commit:
        description: "Bootstrap commit SHA the final tree is built on top of"
        required: true
        type: string
      expected_files:
        description: "Number of cloneable files enumerated at dispatch time"
        required: true
        type: string

permissions:
  contents: write

concurrency:
  group: clipforge-clone-copy
  cancel-in-progress: false

jobs:
  copy:
    name: Copy source files
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Validate inputs
        shell: bash
        run: |
          set -euo pipefail
          printf '%s' "\${{ inputs.source_sha }}" | grep -qE '^[0-9a-f]{40}$'
          printf '%s' "\${{ inputs.bootstrap_commit }}" | grep -qE '^[0-9a-f]{40}$'
          printf '%s' "\${{ inputs.expected_files }}" | grep -qE '^[0-9]+$'

      - name: Check out the clone repository
        uses: actions/checkout@v4
        with:
          ref: "\${{ github.ref_name }}"
          fetch-depth: 0

      - name: Record start status
        shell: bash
        run: |
          set -euo pipefail
          git config user.name  "clipforge-bot"
          git config user.email "clipforge-bot@users.noreply.github.com"
          TOTAL=$(printf '%s' "\${{ inputs.expected_files }}")
          printf '{"version":1,"state":"copying","done":0,"total":%s,"updated_at":"%s"}\\n' "$TOTAL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .clipforge-clone-status.json
          git add .clipforge-clone-status.json
          git commit -m "clipforge: clone copy started" -q
          git push -q origin "HEAD:\${{ github.ref_name }}"

      - name: Fetch the source tree
        shell: bash
        run: |
          set -euo pipefail
          rm -rf /tmp/clipforge-src
          git clone --filter=blob:none --no-checkout --depth 50 https://github.com/${SHADOW_CLONE_SOURCE}.git /tmp/clipforge-src
          cd /tmp/clipforge-src
          git cat-file -e "\${{ inputs.source_sha }}^{commit}" || { echo "source_sha not reachable from ${SHADOW_CLONE_SOURCE} main"; exit 1; }
          git checkout -q "\${{ inputs.source_sha }}"

      - name: Copy cloneable files and report progress
        id: copy
        shell: bash
        run: |
          set -euo pipefail
          copy_one() {
            local p="$1"
            if git -C /tmp/clipforge-src cat-file -e "\${{ inputs.source_sha }}:$p" 2>/dev/null; then
              mkdir -p "$(dirname "$p")"
              git -C /tmp/clipforge-src show "\${{ inputs.source_sha }}:$p" > "$p"
            fi
          }
          git -C /tmp/clipforge-src ls-tree -r --name-only "\${{ inputs.source_sha }}" \
            | grep -Ev '^(branding/|jobs/|audio-library/)' \
            | grep -Eiv 'keys|accounts|queue' \
            > /tmp/clipforge-all.txt
          # Workflow files are NOT copied into the working tree (a GITHUB_TOKEN
          # push may not touch .github/workflows/*). The Dashboard writes them
          # afterwards via the Contents API with the user's PAT.
          grep -v '^\\.github/workflows/' /tmp/clipforge-all.txt > /tmp/clipforge-files.txt
          grep '^\\.github/workflows/' /tmp/clipforge-all.txt > /tmp/clipforge-workflows.txt || true
          git -C /tmp/clipforge-src ls-tree -r "\${{ inputs.source_sha }}" \
            | awk -F'\\t' '{
                p = $2;
                if (substr(p,1,9) == "branding/" || substr(p,1,5) == "jobs/" || substr(p,1,14) == "audio-library/") next;
                tl = tolower(p);
                if (index(tl,"keys") || index(tl,"accounts") || index(tl,"queue")) next;
                split($1, m, " ");
                print m[1] " " p;
              }' > /tmp/clipforge-modes.txt
          TOTAL=$(wc -l < /tmp/clipforge-all.txt | tr -d ' ')
          PUSHABLE=$(wc -l < /tmp/clipforge-files.txt | tr -d ' ')
          if [ "$TOTAL" -eq 0 ]; then echo "no cloneable files found"; exit 1; fi
          if [ "$TOTAL" -ne "\${{ inputs.expected_files }}" ]; then
            echo "warning: enumerated $TOTAL files, expected \${{ inputs.expected_files }}"
          fi
          echo "total=$TOTAL" >> "$GITHUB_OUTPUT"
          CHUNK=25
          COUNT=0
          NEXT=$CHUNK
          while IFS= read -r p; do
            copy_one "$p"
            COUNT=$((COUNT + 1))
            if [ "$COUNT" -ge "$NEXT" ] || [ "$COUNT" -eq "$PUSHABLE" ]; then
              printf '{"version":1,"state":"copying","done":%s,"total":%s,"updated_at":"%s"}\\n' "$COUNT" "$PUSHABLE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .clipforge-clone-status.json
              git add .clipforge-clone-status.json
              git commit -q -m "clipforge: clone copy progress $COUNT/$PUSHABLE"
              git push -q origin "HEAD:\${{ github.ref_name }}"
              NEXT=$((COUNT + CHUNK))
            fi
          done < /tmp/clipforge-files.txt
          if [ "$COUNT" -ne "$PUSHABLE" ]; then echo "copied $COUNT of $PUSHABLE files"; exit 1; fi
          awk '$1 == "100755" { print substr($0, index($0, " ") + 1) }' /tmp/clipforge-modes.txt | while IFS= read -r p; do
            if [ -f "$p" ]; then chmod +x "$p"; fi
          done
          echo "copied=$COUNT" >> "$GITHUB_OUTPUT"

      - name: Publish the full tree
        shell: bash
        env:
          COPIED: \${{ steps.copy.outputs.copied }}
          TOTAL: \${{ steps.copy.outputs.total }}
        run: |
          set -euo pipefail
          git config user.name  "clipforge-bot"
          git config user.email "clipforge-bot@users.noreply.github.com"
          printf '{"version":1,"state":"finalizing","done":%s,"total":%s,"updated_at":"%s"}\\n' "$COPIED" "$TOTAL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .clipforge-clone-status.json
          git add -A
          git commit -q -m "clipforge: copy files from ${SHADOW_CLONE_SOURCE}@\${{ inputs.source_sha }} ($COPIED files)"
          git push -q origin "HEAD:\${{ github.ref_name }}"
          git fetch -q origin "\${{ github.ref_name }}"
          git merge-base --is-ancestor "\${{ inputs.bootstrap_commit }}" "origin/\${{ github.ref_name }}" || { echo "bootstrap commit is not an ancestor of the pushed head"; exit 1; }
          WFCOUNT=$(wc -l < /tmp/clipforge-workflows.txt | tr -d ' ')
          FLOOR=$((TOTAL - WFCOUNT))
          BLOBS=$(git ls-tree -r "origin/\${{ github.ref_name }}" | grep -c ' blob ')
          if [ "$BLOBS" -lt "$FLOOR" ]; then echo "published tree holds $BLOBS blobs, expected at least $FLOOR"; exit 1; fi
          echo "published tree verified: $BLOBS blobs (source workflows pending via the Dashboard)"

      - name: Record completion
        shell: bash
        env:
          TOTAL: \${{ steps.copy.outputs.total }}
          COPIED: \${{ steps.copy.outputs.copied }}
        run: |
          set -euo pipefail
          git config user.name  "clipforge-bot"
          git config user.email "clipforge-bot@users.noreply.github.com"
          git fetch -q origin "\${{ github.ref_name }}"
          git reset -q --hard "origin/\${{ github.ref_name }}"
          printf '{"version":1,"state":"complete","done":%s,"total":%s,"updated_at":"%s"}\\n' "$COPIED" "$TOTAL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .clipforge-clone-status.json
          git add .clipforge-clone-status.json
          git commit -q -m "clipforge: clone copy complete"
          git push -q origin "HEAD:\${{ github.ref_name }}"

      - name: Record failure
        if: failure()
        shell: bash
        env:
          TOTAL: \${{ steps.copy.outputs.total }}
        run: |
          set +e
          git config user.name  "clipforge-bot"
          git config user.email "clipforge-bot@users.noreply.github.com"
          git fetch -q origin "\${{ github.ref_name }}"
          git reset -q --hard "origin/\${{ github.ref_name }}"
          printf '{"version":1,"state":"failed","done":0,"total":%s,"error":"copy workflow step failed — see the Actions run log","updated_at":"%s"}\\n' "\${TOTAL:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .clipforge-clone-status.json
          git add .clipforge-clone-status.json
          git commit -q -m "clipforge: clone copy failed" || true
          git push -q origin "HEAD:\${{ github.ref_name }}" || true
          exit 1
`;
}

/**
 * beginShadowCloneCreation port: create the private repo, bootstrap the sync
 * marker + one-time copy workflow, dispatch it, and return the staged job
 * record for the caller to poll (the Dashboard has no Worker wall-clock
 * limit, so there is no inline fast-path race — the job is ALWAYS staged).
 */
export async function beginShadowCloneCreation(pat, requestedName, options = {}) {
  const report = async (stage, done, total) => {
    if (typeof options.onProgress !== 'function') return;
    try { await options.onProgress({ stage, done: Number(done) || 0, total: Number(total) || 0 }); }
    catch { /* progress display is best-effort */ }
  };
  const identity = await getGitHubIdentity(pat);
  const credentials = { githubPat: String(pat) };
  const name = String(requestedName || '').trim()
    ? cloneRepositoryName(requestedName)
    : await autoCloneRepositoryName(credentials, identity.login);
  const [sourceOwner, sourceName] = SHADOW_CLONE_SOURCE.split('/');

  const sourceRef = await githubRequest(credentials, `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}/git/ref/heads/${encodeURIComponent(DEFAULT_BRANCH)}`);
  const sourceCommitSha = sourceRef && sourceRef.object && sourceRef.object.sha;
  if (!sourceCommitSha) throw new Error('Could not resolve the current ClipForge source revision.');
  const sourceCommit = await githubRequest(credentials, `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}/git/commits/${encodeURIComponent(sourceCommitSha)}`);
  const sourceTreeSha = sourceCommit && sourceCommit.tree && sourceCommit.tree.sha;
  if (!sourceTreeSha) throw new Error('Could not resolve the ClipForge source file tree.');
  const sourceTree = await githubRequest(credentials, `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}/git/trees/${encodeURIComponent(sourceTreeSha)}?recursive=1`);
  if (sourceTree && sourceTree.truncated) throw new Error('The ClipForge source tree is too large to clone safely.');
  const files = Array.isArray(sourceTree && sourceTree.tree)
    ? sourceTree.tree.filter((entry) => entry && entry.type === 'blob' && sourcePathAllowed(entry.path))
    : [];
  if (!files.length) throw new Error('The ClipForge source tree did not contain any cloneable files.');
  await report('source', 0, files.length);

  let target;
  try {
    target = await githubRequest(credentials, '/user/repos', {
      method: 'POST',
      body: { name, private: true, description: 'Private ClipForge Shadow Clone', auto_init: false }
    });
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) {
      throw new Error('A repository with that name already exists in your account. Use “Connect existing clone” instead, or choose a new name.');
    }
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
      throw new Error('The token could not create a repository on your account. A classic PAT needs the “repo” scope; a fine-grained PAT needs “Administration” (write) access.');
    }
    throw error;
  }
  const repo = target && target.full_name ? String(target.full_name) : `${identity.login}/${name}`;
  const targetCredentials = { githubPat: String(pat) };

  // bug-46/47 port: bootstrap the ref with the Contents API (works on an
  // empty repo; Git Data API 409s until a ref exists), on the branch the new
  // repo announced as its default.
  const initialBranch = target && target.default_branch ? String(target.default_branch) : DEFAULT_BRANCH;
  const sync = { source: SHADOW_CLONE_SOURCE, synced_sha: sourceCommitSha, synced_at: new Date().toISOString() };
  const syncPayload = `${JSON.stringify(sync, null, 2)}\n`;
  const cloneCopyWorkflowPayload = `${buildCloneCopyWorkflowYaml()}\n`;
  let bootstrap;
  try {
    bootstrap = await githubRequest(targetCredentials, `/repos/${encodeURIComponent(identity.login)}/${encodeURIComponent(name)}/contents/.clipforge-sync.json`, {
      method: 'PUT',
      body: {
        message: `Initialize Shadow Clone from ${SHADOW_CLONE_SOURCE}@${sourceCommitSha.slice(0, 7)}`,
        content: b64encode(syncPayload),
        branch: initialBranch
      }
    });
    await githubRequest(targetCredentials, `/repos/${encodeURIComponent(identity.login)}/${encodeURIComponent(name)}/contents/.github/workflows/${encodeURIComponent(CLONE_COPY_WORKFLOW)}`, {
      method: 'PUT',
      body: {
        message: 'clipforge: install one-time Shadow Clone copy workflow',
        content: b64encode(cloneCopyWorkflowPayload),
        branch: initialBranch
      }
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      throw new Error(`GitHub could not initialize the new repository: ${error.message}`);
    }
    throw error;
  }

  // bug-47 port: resolve the branch that ACTUALLY became the default — the
  // reported name is trusted only once its ref exists.
  let targetBranch = initialBranch;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let liveBranch = targetBranch;
    try {
      const liveRepo = await githubRequest(targetCredentials, `/repos/${encodeURIComponent(identity.login)}/${encodeURIComponent(name)}`);
      if (liveRepo && liveRepo.default_branch) liveBranch = String(liveRepo.default_branch);
      const head = await githubRequest(targetCredentials, `/repos/${encodeURIComponent(identity.login)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(liveBranch)}`);
      if (head && head.object && head.object.sha) { targetBranch = liveBranch; break; }
    } catch { /* branch ref not settled yet */ }
    targetBranch = liveBranch;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const bootstrapCommitSha = bootstrap && bootstrap.commit && bootstrap.commit.sha;
  if (!bootstrapCommitSha) throw new Error('GitHub did not return a bootstrap commit for the new repository.');
  await report('copy', 0, files.length);

  // Dispatch the one-time copy workflow (retry while GitHub indexes the new
  // workflow file — dispatching immediately can 404 'Workflow not found').
  let dispatched = false;
  let dispatchError = null;
  for (let attempt = 0; attempt < 6 && !dispatched; attempt += 1) {
    try {
      await githubRequest(targetCredentials, `/repos/${encodeURIComponent(identity.login)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(CLONE_COPY_WORKFLOW)}/dispatches`, {
        method: 'POST',
        body: {
          ref: targetBranch,
          inputs: {
            source_sha: sourceCommitSha,
            bootstrap_commit: bootstrapCommitSha,
            expected_files: String(files.length)
          }
        }
      });
      dispatched = true;
    } catch (error) {
      dispatchError = error;
      if (!(error instanceof GitHubError) || (error.status !== 404 && error.status !== 422)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!dispatched) {
    const detail = dispatchError && dispatchError.message ? ` (${dispatchError.message})` : '';
    throw new Error(`GitHub could not start the clone copy workflow${detail}. Connect to the repository anyway and use Sync from source to fill in the missing files.`);
  }

  return {
    pending: true,
    githubPat: String(pat),
    repo,
    login: identity.login,
    name,
    branch: targetBranch,
    sourceSha: sourceCommitSha,
    bootstrapCommitSha,
    totalFiles: files.length,
    startedAt: Date.now(),
    lastAdvanceAt: Date.now()
  };
}

/** Locate the one-time copy workflow's newest run (for cancellation). */
async function findCloneCopyRunId(credentials, repo) {
  const { owner, name } = parseRepo(repo);
  const readNewest = (body) => {
    const runs = body && Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    const run = runs.find((entry) => entry && entry.id && entry.event === 'workflow_dispatch') || runs[0];
    return run && run.id ? run.id : null;
  };
  try {
    const body = await githubRequest(credentials, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=10`);
    const runId = readNewest(body);
    if (runId) return runId;
  } catch { /* fall through */ }
  try {
    const body = await githubRequest(credentials, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(CLONE_COPY_WORKFLOW)}/runs?per_page=10`);
    return readNewest(body);
  } catch {
    return null;
  }
}

/** bug-51 poll port: ONE poll tick for an in-flight Shadow Clone creation. */
export async function pollShadowCloneJob(job) {
  const credentials = { githubPat: String(job.githubPat) };
  const nextJob = { ...job };
  const status = await readCloneCopyStatus(credentials, String(job.branch));
  const now = Date.now();
  if (status) {
    const progressKey = `${status.state}:${status.done}:${status.total}`;
    if (progressKey !== String(job.lastStatusKey || '')) {
      nextJob.lastStatusKey = progressKey;
      nextJob.lastAdvanceAt = now;
    }
    if (status.state === 'failed') {
      nextJob.runId = await findCloneCopyRunId(credentials, job.repo);
      return { status: 'failed', job: nextJob,
        error: new Error(`The clone copy workflow failed${status.error ? `: ${status.error}` : '.'}`) };
    }
    if (status.state === 'complete') {
      nextJob.runId = await findCloneCopyRunId(credentials, job.repo);
      return { status: 'complete', job: nextJob };
    }
    if (now - Number(job.startedAt || now) > CLONE_COPY_DEADLINE_MS) {
      nextJob.runId = await findCloneCopyRunId(credentials, job.repo);
      return { status: 'failed', job: nextJob, error: new Error('The clone copy workflow took too long.') };
    }
    if (now - Number(job.lastAdvanceAt || job.startedAt || now) > CLONE_COPY_STALL_MS) {
      nextJob.runId = await findCloneCopyRunId(credentials, job.repo);
      return { status: 'failed', job: nextJob,
        error: new Error('The clone copy workflow stopped reporting progress (the Actions run may have failed).') };
    }
    return { status: 'running', job: nextJob, progress: status };
  }
  if (now - Number(job.startedAt || now) > CLONE_COPY_START_MS) {
    nextJob.runId = await findCloneCopyRunId(credentials, job.repo);
    return { status: 'failed', job: nextJob, error: new Error('The clone copy workflow never started.') };
  }
  if (now - Number(job.startedAt || now) > CLONE_COPY_DEADLINE_MS) {
    nextJob.runId = await findCloneCopyRunId(credentials, job.repo);
    return { status: 'failed', job: nextJob, error: new Error('The clone copy workflow took too long.') };
  }
  return { status: 'running', job: nextJob };
}

/** Best-effort cancel of a dead/stalled copy run. Never throws. */
export async function cancelShadowCloneRun(job) {
  if (!job || !job.runId || !job.githubPat || !job.repo) return;
  try {
    await cancelWorkflowRun({ githubPat: String(job.githubPat) }, String(job.repo), job.runId);
  } catch { /* best-effort */ }
}

/**
 * bug-51 finalize port: copy the source's workflow files via the Contents
 * API with the user's PAT, delete the one-time workflow, normalize the
 * default branch to main, and verify the tree.
 */
export async function finalizeShadowClone(job) {
  const credentials = { githubPat: String(job.githubPat) };
  const repo = String(job.repo);
  const login = String(job.login);
  const name = String(job.name);
  const [sourceOwner, sourceName] = SHADOW_CLONE_SOURCE.split('/');
  let targetBranch = String(job.branch || DEFAULT_BRANCH);
  const bootstrapCommitSha = String(job.bootstrapCommitSha);
  const sourceCommitSha = String(job.sourceSha);
  const report = typeof job.onProgress === 'function' ? job.onProgress : () => {};

  const sourceCommit = await githubRequest(credentials, `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}/git/commits/${encodeURIComponent(sourceCommitSha)}`);
  const sourceTreeSha = sourceCommit && sourceCommit.tree && sourceCommit.tree.sha;
  if (!sourceTreeSha) throw new Error('Could not resolve the ClipForge source file tree.');
  const sourceTree = await githubRequest(credentials, `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}/git/trees/${encodeURIComponent(sourceTreeSha)}?recursive=1`);
  const files = Array.isArray(sourceTree && sourceTree.tree)
    ? sourceTree.tree.filter((entry) => entry && entry.type === 'blob' && sourcePathAllowed(entry.path))
    : [];

  // bug-63 port: workflow files must be written with the user's PAT (the
  // run's GITHUB_TOKEN cannot touch .github/workflows/*).
  const workflowFiles = files.filter((file) => /^\.github\/workflows\//.test(file.path) && file.path !== `.github/workflows/${CLONE_COPY_WORKFLOW}`);
  for (const file of workflowFiles) {
    const sourceBlob = await githubRequest(credentials, `/repos/${encodeURIComponent(sourceOwner)}/${encodeURIComponent(sourceName)}/git/blobs/${encodeURIComponent(file.sha)}`);
    if (!sourceBlob || sourceBlob.encoding !== 'base64' || typeof sourceBlob.content !== 'string') {
      throw new Error(`Could not read source file ${file.path}.`);
    }
    let existingSha = null;
    try {
      const existing = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/contents/${encodePath(file.path)}?ref=${encodeURIComponent(targetBranch)}`);
      existingSha = existing && existing.sha ? existing.sha : null;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }
    await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/contents/${encodePath(file.path)}`, {
      method: 'PUT',
      body: {
        message: `clipforge: copy workflow file ${file.path}`,
        content: sourceBlob.content.replace(/\n/g, ''),
        branch: targetBranch,
        ...(existingSha ? { sha: existingSha } : {})
      }
    });
  }
  // Self-delete the one-time copy workflow (best-effort).
  try {
    const workflowPath = `.github/workflows/${CLONE_COPY_WORKFLOW}`;
    const existing = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/contents/${encodePath(workflowPath)}?ref=${encodeURIComponent(targetBranch)}`);
    if (existing && existing.sha) {
      await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/contents/${encodePath(workflowPath)}`, {
        method: 'DELETE',
        body: { message: 'clipforge: remove one-time clone copy workflow', sha: existing.sha, branch: targetBranch }
      });
    }
  } catch { /* lingering one-time workflow is inert */ }

  const headAfterCopy = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
  const finalCommitSha = headAfterCopy && headAfterCopy.object && headAfterCopy.object.sha;
  if (!finalCommitSha || finalCommitSha === bootstrapCommitSha) {
    throw new Error('Shadow Clone verification failed: the copy workflow reported completion but the repository head did not advance past the bootstrap commit.');
  }
  const finalCommit = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/git/commits/${encodeURIComponent(finalCommitSha)}`);
  const finalTreeSha = finalCommit && finalCommit.tree && finalCommit.tree.sha;
  if (!finalTreeSha) throw new Error('Shadow Clone verification failed: GitHub did not return the copied file tree.');
  await report({ stage: 'finalize', done: files.length, total: files.length });

  try {
    if (targetBranch !== DEFAULT_BRANCH) {
      await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/git/refs`, {
        method: 'POST', body: { ref: `refs/heads/${DEFAULT_BRANCH}`, sha: finalCommitSha }
      });
      await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`, {
        method: 'PATCH', body: { default_branch: DEFAULT_BRANCH }
      });
      await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/git/refs/heads/${encodeURIComponent(targetBranch)}`, {
        method: 'DELETE'
      });
      targetBranch = DEFAULT_BRANCH;
    }
    const verifyRepo = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}`);
    const verifyBranch = verifyRepo && verifyRepo.default_branch ? String(verifyRepo.default_branch) : targetBranch;
    const verifyRef = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(verifyBranch)}`);
    const verifySha = verifyRef && verifyRef.object && verifyRef.object.sha;
    if (verifySha !== finalCommitSha) {
      throw new Error(`Shadow Clone verification failed: the repository's default branch (${verifyBranch}) does not point at the copied file tree.`);
    }
    const verifyTree = await githubRequest(credentials, `/repos/${encodeURIComponent(login)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(finalTreeSha)}?recursive=1`);
    const verifyBlobs = Array.isArray(verifyTree && verifyTree.tree) ? verifyTree.tree.filter((entry) => entry && entry.type === 'blob').length : 0;
    if (!verifyTree || verifyTree.truncated || verifyBlobs < files.length) {
      throw new Error(`Shadow Clone verification failed: the pushed file tree holds ${verifyBlobs} files, expected at least ${files.length}.`);
    }
  } catch (error) {
    if (error instanceof GitHubError) {
      throw new Error(`GitHub rejected a write to the new repository (${error.status || 'unknown'}): ${error.message}`);
    }
    throw error;
  }
  return { repo, login, sourceSha: sourceCommitSha, copiedFiles: files.length, branch: targetBranch };
}
